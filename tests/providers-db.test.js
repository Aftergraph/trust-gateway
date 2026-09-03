'use strict';
// FS-A4 phase 1 — providers store migration (providers-db.js).
//
// Covers the five migration guarantees:
//   1. import-from-JSON: first DB access ingests data/providers.json,
//      fail closed on corrupt/malformed JSON.
//   2. DB authority: after import, reads/writes hit SQLite and the JSON
//      file is never rewritten (dual consistency: mutate → DB row changed,
//      file bytes unchanged).
//   3. env-off byte-identical: TG_PROVIDERS_DB unset returns the original
//      providers-singleton registry for the same gw (WeakMap identity) and
//      persists to JSON exactly like legacy.
//   4. restart persistence: a new DB registry on the same TG_DB_FILE sees
//      the previous instance's mutations.
//   5. seed safety: SEED providers survive an import that lacks them, and
//      stale DB entries gain new SEED models on upgrade.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function jest_reset() {
  for (const m of Object.keys(require.cache)) {
    if (
      m.endsWith('/src/gateway/db.js') ||
      m.endsWith('/src/gateway/kvstore.js') ||
      m.endsWith('/src/gateway/providers.js') ||
      m.endsWith('/src/gateway/providers-db.js') ||
      m.endsWith('/src/gateway/providers-singleton.js')
    ) {
      delete require.cache[m];
    }
  }
}

function fresh() {
  jest_reset();
  const { getProviders, ProviderRegistryDb } = require('../src/gateway/providers-db');
  const { db } = require('../src/gateway/db');
  const { getRegistry } = require('../src/gateway/providers-singleton');
  return { getProviders, ProviderRegistryDb, db, getRegistry };
}

// Module-graph handle for tests that only need the raw connection.
let currentDb;
function theDb() {
  jest_reset();
  currentDb = require('../src/gateway/db').db;
  return currentDb;
}

function withDb(name, fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `fsa4-pdb-${name}-`));
  fs.mkdirSync(path.join(dir, 'data'), { recursive: true });
  const jsonPath = path.join(dir, 'data', 'providers.json');
  const dbFile = path.join(dir, 'data', 'gateway.db');
  const prevDb = process.env.TG_DB_FILE;
  const prevFlag = process.env.TG_PROVIDERS_DB;
  const prevCwd = process.cwd();
  process.env.TG_DB_FILE = dbFile;
  delete process.env.TG_PROVIDERS_DB;
  process.chdir(dir); // cwd-relative defaults (data/providers.json) resolve here
  try {
    fn({ dir, jsonPath, dbFile });
  } finally {
    process.chdir(prevCwd);
    if (prevDb === undefined) delete process.env.TG_DB_FILE;
    else process.env.TG_DB_FILE = prevDb;
    if (prevFlag === undefined) delete process.env.TG_PROVIDERS_DB;
    else process.env.TG_PROVIDERS_DB = prevFlag;
  }
}

function writeJson(jsonPath, providers) {
  fs.writeFileSync(jsonPath, JSON.stringify({ providers }, null, 2) + '\n');
}

test('providers-db: first access imports providers.json into SQLite', () => {
  withDb('import', ({ jsonPath, dbFile }) => {
    writeJson(jsonPath, [
      { name: 'custom', kind: 'direct', baseUrl: 'https://x/y', models: ['m1'], defaultModel: 'm1', status: 'ok' },
    ]);
    process.env.TG_PROVIDERS_DB = '1';
    const { getProviders } = fresh();
    const r = getProviders({});
    // custom came from JSON, seeds came from SEED
    assert.deepEqual(r.get('custom').models, ['m1']);
    assert.equal(r.get('dialagram').models.length, 17);
    // the providers table actually has rows
    const rows = theDb()
      .prepare('SELECT name, record FROM providers ORDER BY name')
      .all();
    assert.ok(rows.length >= 8);
    assert.ok(rows.some((row) => row.name === 'custom'));
    assert.ok(fs.existsSync(dbFile), 'state lives in the unified gateway.db');
  });
});

test('providers-db: fail closed on corrupt or malformed providers.json', () => {
  withDb('corrupt', ({ jsonPath }) => {
    fs.writeFileSync(jsonPath, '{not json');
    process.env.TG_PROVIDERS_DB = '1';
    const { ProviderRegistryDb } = fresh();
    assert.throws(
      () => new ProviderRegistryDb({ jsonFile: jsonPath }),
      /unparseable.*fail closed/
    );
    // malformed shape
    fs.writeFileSync(jsonPath, '{"nope": true}');
    assert.throws(
      () => new ProviderRegistryDb({ jsonFile: jsonPath }),
      /must be \{providers: \[\.\.\.\]\}/
    );
    // entry without a name
    writeJson(jsonPath, [{ kind: 'direct' }]);
    assert.throws(
      () => new ProviderRegistryDb({ jsonFile: jsonPath }),
      /missing name/
    );
  });
});

test('providers-db: DB is authoritative — mutations hit SQLite, JSON untouched', () => {
  withDb('dual', ({ jsonPath }) => {
    writeJson(jsonPath, [
      { name: 'custom', kind: 'direct', baseUrl: 'https://x/y', models: ['m1'], defaultModel: 'm1' },
    ]);
    const before = fs.readFileSync(jsonPath);
    process.env.TG_PROVIDERS_DB = '1';
    const { getProviders, db } = fresh();
    const r = getProviders({});
    r.get('custom').status = 'ok';
    r.get('custom').models.push('m2');
    r._save();

    // DB row changed…
    const row = db.prepare('SELECT record FROM providers WHERE name = ?').get('custom');
    const rec = JSON.parse(row.record);
    assert.equal(rec.status, 'ok');
    assert.deepEqual(rec.models, ['m1', 'm2']);
    // …and the JSON file is byte-identical to before the DB writes.
    assert.equal(fs.readFileSync(jsonPath, 'utf8'), before.toString());
    // JSON still parses as the ORIGINAL content (never rewritten by the DB path)
    const j = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
    assert.deepEqual(j.providers[0].models, ['m1']);
  });
});

test('providers-db: restart reloads state from SQLite', () => {
  withDb('restart', ({ jsonPath }) => {
    writeJson(jsonPath, [
      { name: 'custom', kind: 'direct', baseUrl: 'https://x/y', models: ['m1'], defaultModel: 'm1' },
    ]);
    process.env.TG_PROVIDERS_DB = '1';
    let { getProviders } = fresh();
    const r1 = getProviders({});
    r1.get('custom').status = 'ok';
    r1._save();
    // "restart": fresh module graph on the same TG_DB_FILE
    delete process.env.TG_PROVIDERS_DB;
    process.env.TG_PROVIDERS_DB = '1';
    ({ getProviders } = fresh());
    const r2 = getProviders({});
    assert.equal(r2.get('custom').status, 'ok');
    // and the JSON import does NOT run again — deleting the file proves the
    // DB alone is now the source of truth
    fs.unlinkSync(jsonPath);
    ({ getProviders } = fresh());
    const r3 = getProviders({});
    assert.equal(r3.get('custom').status, 'ok');
  });
});

test('providers-db: env unset → byte-identical legacy singleton', () => {
  withDb('legacy', ({ jsonPath }) => {
    const { getProviders, getRegistry } = fresh();
    const gw = {};
    const r = getProviders(gw); // TG_PROVIDERS_DB unset
    assert.equal(r, getRegistry(gw)); // same WeakMap-cached instance
    assert.equal(r.constructor.name, 'ProviderRegistry');
    // second call caches per gateway like legacy
    assert.equal(getProviders(gw), r);
    // legacy persistence still writes JSON
    r.get('openai').baseUrl = 'https://legacy.test/v1';
    r._save();
    const j = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
    assert.equal(j.providers.find((p) => p.name === 'openai').baseUrl, 'https://legacy.test/v1');
  });
});

test('providers-db: env set → WeakMap-cached DB registry per gateway', () => {
  withDb('cache', () => {
    process.env.TG_PROVIDERS_DB = '1';
    const { getProviders } = fresh();
    const gw = {};
    const a = getProviders(gw);
    const b = getProviders(gw);
    assert.equal(a, b);
    assert.ok(a.constructor.name === 'ProviderRegistryDb');
  });
});

test('providers-db: SEED survives import-from-JSON and upgrades gain models', () => {
  withDb('seed', ({ jsonPath }) => {
    // JSON missing most SEED providers entirely
    writeJson(jsonPath, [{ name: 'legacy-only', kind: 'direct', models: ['x'] }]);
    process.env.TG_PROVIDERS_DB = '1';
    let { getProviders } = fresh();
    let r = getProviders({});
    assert.ok(r.get('legacy-only'));
    assert.ok(r.get('dialagram'), 'SEED added after import');
    assert.ok(r.get('openai'), 'SEED added after import');

    // stale DB entry gains new SEED models on upgrade (SEED is the set)
    const stale = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
    stale.providers[0].name = 'dialagram';
    stale.providers[0].models = ['ancient-model'];
    fs.writeFileSync(jsonPath, JSON.stringify(stale));
    fs.unlinkSync(process.env.TG_DB_FILE); // fresh import path
    ({ getProviders } = fresh());
    const r2 = getProviders({});
    const d = r2.get('dialagram');
    assert.ok(d.models.includes('ancient-model'), 'stale model preserved');
    assert.ok(d.models.includes('qwen-3.7-max'), 'SEED model merged in');
    assert.equal(d.defaultModel, 'qwen-3.7-max');
  });
});

test('providers-db: DB registry is a full ProviderRegistry — plan() works', () => {
  withDb('plan', () => {
    process.env.TG_PROVIDERS_DB = '1';
    const { getProviders } = fresh();
    const r = getProviders({});
    const plan = r.plan({ task: 'summarise this', preferFree: true });
    assert.equal(plan.primary.provider, 'ollama-cloud');
    assert.equal(plan.primary.model, 'glm-5.3-flash');
    assert.ok(Array.isArray(plan.fallbacks));
    // models() projection intact
    const models = r.models();
    assert.ok(models.some((m) => m.provider === 'custom' || m.provider === 'dialagram'));
    assert.equal(r.list().length, r.providers.size);
  });
});