'use strict';
// FS-A4 phase 1 — kv_store on the unified gateway SQLite (db.js + kvstore.js).
//
// Covers: CRUD round-trip (any JSON value), tx commit/rollback (including
// composed multi-key units), list/count prefix behaviour (with LIKE-wildcard
// keys), getRow raw shape, and restart persistence (reopen from the same
// TG_DB_FILE — the same mechanism data/gateway.db uses in production).

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function withDbFile(name, fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `fsa4-kv-${name}-`));
  const prev = process.env.TG_DB_FILE;
  const prevCwd = process.cwd();
  process.env.TG_DB_FILE = path.join(dir, 'gateway.db');
  process.chdir(dir); // cwd-relative defaults (data/...) land in the temp dir
  try {
    fn(path.join(dir, 'gateway.db'));
  } finally {
    process.chdir(prevCwd);
    if (prev === undefined) delete process.env.TG_DB_FILE;
    else process.env.TG_DB_FILE = prev;
  }
}

// Fresh module graph per case so the db.js module-singleton reopens the
// temp file (require cache would otherwise pin the first connection).
function fresh() {
  jest_reset();
  const { KV } = require('../src/gateway/kvstore');
  const { db, tx, json, unjson } = require('../src/gateway/db');
  return { KV, db, tx, json, unjson };
}

// node:test runs files in one process; bust the require cache for the two
// modules under test between cases that use different TG_DB_FILE values.
function jest_reset() {
  for (const m of Object.keys(require.cache)) {
    if (m.endsWith('/src/gateway/db.js') || m.endsWith('/src/gateway/kvstore.js')) {
      delete require.cache[m];
    }
  }
}

test('KV: CRUD round-trips every JSON value type', () => {
  withDbFile('crud', () => {
    const { KV } = fresh();
    const kv = new KV();
    assert.equal(kv.get('missing'), null);

    kv.set('s', 'text');
    kv.set('n', 42);
    kv.set('b', true);
    kv.set('nul', null);
    kv.set('o', { nested: { list: [1, 2, 3] } });
    assert.equal(kv.get('s'), 'text');
    assert.equal(kv.get('n'), 42);
    assert.equal(kv.get('b'), true);
    assert.equal(kv.get('nul'), null);
    assert.deepEqual(kv.get('o'), { nested: { list: [1, 2, 3] } });

    // upsert overwrites
    kv.set('n', 43);
    assert.equal(kv.get('n'), 43);
    // del removes exactly once
    assert.equal(kv.del('n'), true);
    assert.equal(kv.get('n'), null);
    assert.equal(kv.del('n'), false);
  });
});

test('KV: list/count honour prefix, escape LIKE wildcards, stay ordered', () => {
  withDbFile('list', () => {
    const { KV } = fresh();
    const kv = new KV();
    kv.set('cfg:a', 1);
    kv.set('cfg:b', 2);
    kv.set('cfg:ab', 3);
    kv.set('other', 4);
    kv.set('weird%key', 5);
    kv.set('under_score', 6);
    assert.deepEqual(kv.list('cfg:').map((e) => e.key), ['cfg:a', 'cfg:ab', 'cfg:b']);
    assert.deepEqual(kv.list().map((e) => e.key).sort(), [
      'cfg:a', 'cfg:ab', 'cfg:b', 'other', 'under_score', 'weird%key',
    ].sort());
    assert.equal(kv.count('cfg:'), 3);
    assert.equal(kv.count(), 6);
    // literal match, not pattern match
    assert.equal(kv.count('weird%'), 1);
    assert.equal(kv.count('under_'), 1);
    assert.deepEqual(kv.list('weird%'), [{ key: 'weird%key', value: 5 }]);
  });
});

test('KV: getRow exposes raw stored shape with updated_at', () => {
  withDbFile('row', () => {
    const { KV } = fresh();
    const kv = new KV();
    const before = Date.now();
    const row = kv.set('k', { v: 1 });
    assert.equal(row.key, 'k');
    assert.equal(row.updated_at >= before, true);
    assert.equal(JSON.parse(row.value).v, 1);
    assert.equal(kv.getRow('nope'), null);
  });
});

test('KV: tx() commits composed writes; rollback undoes them atomically', () => {
  withDbFile('tx', () => {
    const { KV, tx } = fresh();
    const kv = new KV();
    // compose two mutations — both commit together
    tx(() => {
      kv.set('acct:a', 100);
      kv.set('acct:b', 0);
    });
    assert.equal(kv.get('acct:a'), 100);
    assert.equal(kv.get('acct:b'), 0);
    // throw mid-transaction → NOTHING from inside lands
    assert.throws(() =>
      tx(() => {
        kv.set('acct:a', 999);
        kv.set('acct:b', 999);
        throw new Error('boom');
      })
    );
    assert.equal(kv.get('acct:a'), 100); // untouched
    assert.equal(kv.get('acct:b'), 0);
    // nested tx joins the outer unit
    assert.throws(() =>
      tx(() => {
        kv.set('acct:a', 500);
        tx(() => kv.set('acct:b', 500));
        throw new Error('nope');
      })
    );
    assert.equal(kv.get('acct:a'), 100);
    assert.equal(kv.get('acct:b'), 0);
  });
});

test('KV: values survive a restart from the same sqlite file', () => {
  withDbFile('restart', (file) => {
    let { KV } = fresh();
    const kv1 = new KV();
    kv1.set('durable', { hits: 7 });
    // simulate process restart: drop cached connection, reopen same file
    jest_reset();
    ({ KV } = require('../src/gateway/kvstore'));
    process.env.TG_DB_FILE = file;
    const kv2 = new KV();
    assert.deepEqual(kv2.get('durable'), { hits: 7 });
    assert.equal(kv2.count(), 1);
  });
});

test('db.js: json()/unjson() contract on TEXT columns', () => {
  withDbFile('json', () => {
    const { json, unjson, db } = fresh();
    assert.equal(json(undefined), null);
    assert.equal(json(null), 'null');
    assert.equal(json({ a: 1 }), '{"a":1}');
    assert.equal(unjson(null), null);
    assert.equal(unjson('not json'), null);
    assert.deepEqual(unjson('{"a":1}'), { a: 1 });
    // single shared connection exists and serves queries
    assert.equal(db.prepare("SELECT 1 AS one").get().one, 1);
  });
});
