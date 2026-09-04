'use strict';
// FS-A5 phase 2 — approvals store migration (approvals-db.js).
//
// Covers the migration guarantees:
//   1. import-from-JSON: first DB access ingests data/approvals.json
//      (pending survive restart), fail closed on corrupt/malformed JSON.
//   2. SCRUB-ON-PERSIST: resolved/expired approvals NEVER carry raw args —
//      args_json and args_summary_json are NULL in the DB for every
//      non-pending row (same guarantee as the JSON path).
//   3. DB authority: after import, request/resolve/get hit SQLite and the
//      JSON file is byte-identical afterwards (frozen post-import).
//   4. env-off byte-identical: TG_APPROVALS_DB unset returns a legacy
//      JSON-backed ApprovalStore, WeakMap-cached per gateway (instance identity).
//   5. restart persistence: a new DB store on the same TG_DB_FILE sees the
//      previous instance's approvals; JSON is NOT re-imported; the id
//      counter continues where it left off.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function jest_reset() {
  // Reset the database connection before clearing cache so tests get fresh connection
  try {
    const dbModule = require('../src/gateway/db');
    if (dbModule.resetDb) dbModule.resetDb();
  } catch {
    // Not loaded yet or error
  }
  for (const m of Object.keys(require.cache)) {
    if (
      m.endsWith('/src/gateway/db.js') ||
      m.endsWith('/src/gateway/approvals.js') ||
      m.endsWith('/src/gateway/approvals-db.js') ||
      m.endsWith('/src/gateway/impact.js')
    ) {
      delete require.cache[m];
    }
  }
}

function fresh() {
  jest_reset();
  const { getApprovals, ApprovalStoreDb } = require('../src/gateway/approvals-db');
  const { db } = require('../src/gateway/db');
  return { getApprovals, ApprovalStoreDb, db };
}

let currentDb;
function theDb() {
  jest_reset();
  return require('../src/gateway/db').db;
}

function withDb(name, fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `fsa5-adb-${name}-`));
  fs.mkdirSync(path.join(dir, 'data'), { recursive: true });
  const jsonPath = path.join(dir, 'data', 'approvals.json');
  const dbFile = path.join(dir, 'data', 'gateway.db');
  const prevDb = process.env.TG_DB_FILE;
  const prevFlag = process.env.TG_APPROVALS_DB;
  const prevCwd = process.cwd();
  process.env.TG_DB_FILE = dbFile;
  delete process.env.TG_APPROVALS_DB;
  process.chdir(dir);
  try {
    fn({ dir, jsonPath, dbFile });
  } finally {
    process.chdir(prevCwd);
    if (prevDb === undefined) delete process.env.TG_DB_FILE;
    else process.env.TG_DB_FILE = prevDb;
    if (prevFlag === undefined) delete process.env.TG_APPROVALS_DB;
    else process.env.TG_APPROVALS_DB = prevFlag;
  }
}

test('approvals-db: first access imports approvals.json into SQLite (pending survive)', () => {
  withDb('import', ({ jsonPath, dbFile }) => {
    const seeded = [
      {
        id: 'apr_000001',
        bot: 'scraper',
        tool: 'http.fetch',
        args: { url: 'https://x/y', apiKey: 'sk-secret' },
        argsSummary: '{"url":"https://x/y","apiKey":"sk-secret"}',
        reason: 'need the page',
        status: 'pending',
        createdAt: 1000,
        expiresAt: Date.now() + 3_600_000,
        resolvedBy: null,
        resolvedAt: null,
        impact: { level: 'low' },
      },
      {
        id: 'apr_000002',
        bot: 'scraper',
        tool: 'http.fetch',
        args: null, // resolved rows are already scrubbed in the JSON
        argsSummary: null,
        reason: null,
        status: 'approved',
        createdAt: 500,
        expiresAt: 900000,
        resolvedBy: 'owner@x',
        resolvedAt: 600,
        impact: { level: 'low' },
      },
    ];
    fs.writeFileSync(jsonPath, JSON.stringify(seeded) + '\n');
    process.env.TG_APPROVALS_DB = '1';
    const { getApprovals } = fresh();
    const s = getApprovals({});
    assert.equal(s.get('apr_000001').status, 'pending');
    assert.equal(s.get('apr_000002').status, 'approved');
    assert.deepEqual(s.get('apr_000001').args, seeded[0].args);
    // table rows exist; the RESOLVED row carries NO args in the DB
    const rows = theDb()
      .prepare('SELECT id, bot, tool, args_json, status, requested_by, resolved_by, created_at, resolved_at FROM approvals ORDER BY id')
      .all();
    assert.equal(rows.length, 2);
    const pending = rows[0];
    assert.equal(pending.bot, 'scraper');
    assert.equal(pending.tool, 'http.fetch');
    assert.equal(pending.status, 'pending');
    assert.equal(pending.requested_by, 'scraper');
    assert.equal(pending.resolved_by, null);
    assert.equal(pending.created_at, 1000);
    assert.equal(pending.resolved_at, null);
    assert.ok(pending.args_json.includes('sk-secret'), 'pending args persisted');
    const resolved = rows[1];
    assert.equal(resolved.args_json, null, 'resolved row has NO args in the DB');
    assert.equal(resolved.resolved_by, 'owner@x');
    assert.equal(resolved.resolved_at, 600);
    assert.ok(fs.existsSync(dbFile), 'state lives in the unified gateway.db');
  });
});

test('approvals-db: request/resolve CRUD hits SQLite; JSON stays byte-identical', () => {
  withDb('crud', ({ jsonPath }) => {
    fs.writeFileSync(jsonPath, '[]\n');
    const before = fs.readFileSync(jsonPath, 'utf8');
    process.env.TG_APPROVALS_DB = '1';
    const { getApprovals, db } = fresh();
    const s = getApprovals({});
    // request
    const req = s.request({ bot: { name: 'scraper' }, tool: 'http.fetch', args: { url: 'https://x' } });
    assert.equal(req.status, 'pending');
    let row = db.prepare('SELECT id, bot, tool, args_json, status FROM approvals WHERE id = ?').get(req.id);
    assert.equal(row.bot, 'scraper');
    assert.equal(row.tool, 'http.fetch');
    assert.ok(row.args_json.includes('https://x'));
    // listPending
    assert.equal(s.listPending().length, 1);
    // resolve — approve
    const out = s.resolve(req.id, 'approve', 'owner@x');
    assert.ok(out.ok);
    assert.equal(out.request.status, 'approved');
    row = db.prepare('SELECT args_json, args_summary_json, status, resolved_by, resolved_at FROM approvals WHERE id = ?').get(req.id);
    assert.equal(row.args_json, null, 'SCRUBBED: resolved approval has NO args in the DB');
    assert.equal(row.args_summary_json, null, 'summary scrubbed too');
    assert.equal(row.status, 'approved');
    assert.equal(row.resolved_by, 'owner@x');
    assert.ok(row.resolved_at !== null);
    // double resolve fails closed
    assert.deepEqual(s.resolve(req.id, 'deny', 'owner@x'), { ok: false, error: 'already_approved' });
    // deny path
    const req2 = s.request({ bot: { name: 'mail' }, tool: 'smtp.send', args: { to: 'a@b' } });
    assert.ok(s.resolve(req2.id, 'deny', 'owner@x').ok);
    assert.equal(db.prepare('SELECT status FROM approvals WHERE id = ?').get(req2.id).status, 'denied');
    // …and the JSON file is byte-identical to before the DB writes
    assert.equal(fs.readFileSync(jsonPath, 'utf8'), before);
  });
});

test('approvals-db: SCRUB-ON-RESOLVE — raw args never reach the DB for resolved rows', () => {
  withDb('scrub', ({ jsonPath }) => {
    fs.writeFileSync(jsonPath, '[]\n');
    process.env.TG_APPROVALS_DB = '1';
    const { getApprovals } = fresh();
    const s = getApprovals({});
    const req = s.request({ bot: { name: 'mail' }, tool: 'smtp.send', args: { apiKey: 'sk-super-secret' } });
    s.resolve(req.id, 'deny', 'owner@x');
    // the secret is gone from memory AND from every DB column
    assert.equal(s.get(req.id).args, null);
    const raw = JSON.stringify(
      theDb().prepare('SELECT * FROM approvals').all()
    );
    assert.ok(!raw.includes('sk-super-secret'), 'secret not in any DB column');
    // and it survives neither a restart
    const { getApprovals: getA2 } = fresh();
    const s2 = getA2({});
    assert.equal(s2.get(req.id).args, null);
    const raw2 = JSON.stringify(theDb().prepare('SELECT * FROM approvals').all());
    assert.ok(!raw2.includes('sk-super-secret'));
  });
});

test('approvals-db: expiry fails closed and scrubs args', () => {
  withDb('expiry', ({ jsonPath }) => {
    fs.writeFileSync(jsonPath, '[]\n');
    let clock = 1000;
    process.env.TG_APPROVALS_DB = '1';
    const { getApprovals, db } = fresh();
    const s = getApprovals({}, { now: () => clock, ttlMs: 100, jsonFile: jsonPath });
    const req = s.request({ bot: { name: 'mail' }, tool: 'smtp.send', args: { apiKey: 'sk-expiring' } });
    clock = 2000; // past expiry
    assert.deepEqual(s.resolve(req.id, 'approve', 'owner@x'), { ok: false, error: 'expired' });
    assert.equal(s.get(req.id).status, 'expired');
    const row = db.prepare('SELECT args_json, args_summary_json, status FROM approvals WHERE id = ?').get(req.id);
    assert.equal(row.status, 'expired');
    assert.equal(row.args_json, null, 'expired args scrubbed from DB');
    assert.ok(!JSON.stringify(row).includes('sk-expiring'));
  });
});

test('approvals-db: fail closed on corrupt or malformed approvals.json', () => {
  withDb('corrupt', ({ jsonPath }) => {
    process.env.TG_APPROVALS_DB = '1';
    const { getApprovals } = fresh();
    const gw = {};
    fs.writeFileSync(jsonPath, '{not json');
    assert.throws(() => getApprovals(gw), /unparseable.*fail closed/);
    fs.writeFileSync(jsonPath, '{"nope": true}');
    assert.throws(() => getApprovals(gw), /must be a JSON array/);
    fs.writeFileSync(jsonPath, '[{"status":"pending"}]');
    assert.throws(() => getApprovals(gw), /entry missing id/);
    // nothing was imported
    assert.equal(theDb().prepare('SELECT COUNT(*) AS n FROM approvals').get().n, 0);
  });
});

test('approvals-db: restart keeps pending approvals + id counter; JSON not re-imported', () => {
  withDb('restart', ({ jsonPath }) => {
    fs.writeFileSync(jsonPath, '[]\n');
    process.env.TG_APPROVALS_DB = '1';
    let { getApprovals } = fresh();
    let s = getApprovals({});
    const req = s.request({ bot: { name: 'mail' }, tool: 'smtp.send', args: { to: 'a@b' } });
    assert.equal(req.id, 'apr_000001');
    // "restart": fresh module graph on the same TG_DB_FILE
    ({ getApprovals } = fresh());
    s = getApprovals({});
    const parked = s.get(req.id);
    assert.equal(parked.status, 'pending', 'pending approval survived restart');
    assert.deepEqual(parked.args, { to: 'a@b' });
    assert.equal(s.listPending().length, 1);
    // id counter continued — no collision after restart
    const req2 = s.request({ bot: { name: 'mail' }, tool: 'smtp.send', args: {} });
    assert.equal(req2.id, 'apr_000002');
    // the JSON import does NOT run again — deleting the file proves the DB
    // alone is now the source of truth
    fs.unlinkSync(jsonPath);
    ({ getApprovals } = fresh());
    s = getApprovals({});
    assert.equal(s.get(req.id).status, 'pending');
    assert.equal(s.get(req2.id).status, 'pending');
  });
});

test('approvals-db: env unset → byte-identical legacy JSON store, instance identity', () => {
  withDb('legacy', ({ jsonPath }) => {
    const { getApprovals } = fresh();
    const gw = {};
    const s = getApprovals(gw, { file: jsonPath }); // TG_APPROVALS_DB unset
    assert.equal(s.constructor.name, 'ApprovalStore');
    assert.equal(getApprovals(gw, { file: jsonPath }), s, 'same WeakMap-cached instance');
    // legacy persistence still writes JSON — pending survive there too
    const req = s.request({ bot: { name: 'mail' }, tool: 'smtp.send', args: { to: 'a@b' } });
    const j = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
    assert.ok(j.some((r) => r.id === req.id && r.status === 'pending'));
    // and no DB table was created for the legacy path
    const tables = theDb()
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='approvals'")
      .all();
    assert.equal(tables.length, 0, 'legacy path never touches SQLite');
  });
});

test('approvals-db: env set → WeakMap-cached DB store per gateway', () => {
  withDb('cache', () => {
    process.env.TG_APPROVALS_DB = '1';
    const { getApprovals } = fresh();
    const gw = {};
    const a = getApprovals(gw);
    const b = getApprovals(gw);
    assert.equal(a, b);
    assert.equal(a.constructor.name, 'ApprovalStoreDb');
  });
});