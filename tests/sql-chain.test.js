'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { HashChain } = require('../src/gateway/hash-chain');
const { SqlChain } = require('../src/gateway/sql-chain');

function tmpDb(name = 'sql-chain.test.db') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sql-chain-'));
  return { dir, file: path.join(dir, name) };
}

function cleanup(handle) {
  for (const f of [handle.file, handle.file + '-wal', handle.file + '-shm', handle.file + '-journal']) {
    try { fs.unlinkSync(f); } catch {}
  }
  try { fs.rmSync(handle.dir, { recursive: true, force: true }); } catch {}
}

test('genesis on new db verifies and exposes chainId', () => {
  const h = tmpDb();
  try {
    const c = new SqlChain({ file: h.file });
    const v = c.verify();
    assert.equal(v.ok, true);
    assert.equal(v.length, 1);
    assert.equal(c.entries[0].payload.type, 'genesis');
    assert.ok(c.chainId && c.chainId.length > 0, 'chainId present');
    c.close();
  } finally { cleanup(h); }
});

test('append + verify against identical payload sequence matches HashChain head (cross-implementation equivalence)', () => {
  const h1 = tmpDb('equiv.db');
  try {
    // Build a HashChain with a known chainId+ts, then mirror it into SqlChain.
    const hashChain = new HashChain();
    const sharedChainId = hashChain.chainId;
    const sharedGenesisTs = hashChain.entries[0].ts;

    const sqlChain = new SqlChain({
      file: h1.file,
      chainId: sharedChainId,
      genesisTs: sharedGenesisTs,
    });
    assert.equal(sqlChain.head.hash, hashChain.head.hash, 'genesis hashes match with shared chainId+ts');

    for (let i = 1; i <= 10; i++) {
      const payload = { kind: 'read', n: i, nested: { a: i, b: `tag-${i}` } };
      const ts = sharedGenesisTs + i * 1000;
      hashChain.append(payload, ts);
      sqlChain.append(payload, ts);
      assert.equal(sqlChain.head.hash, hashChain.head.hash, `head hashes match after ${i} appends`);
    }

    const hv = hashChain.verify();
    const sv = sqlChain.verify();
    assert.equal(sv.ok, true);
    assert.equal(sv.head, hv.head);
    assert.equal(sv.length, hv.length);
    sqlChain.close();
  } finally { cleanup(h1); }
});

test('since() returns lazily-loaded entries with seq > n and reconstructs payload objects', () => {
  const h = tmpDb();
  try {
    const s = new SqlChain({ file: h.file });
    for (let i = 1; i <= 5; i++) s.append({ i });
    const tail = s.since(2);
    assert.equal(tail.entries.length, 3);
    assert.deepStrictEqual(tail.entries.map((e) => e.seq), [3, 4, 5]);
    assert.deepStrictEqual(tail.entries[0].payload, { i: 3 });
    assert.equal(typeof tail.entries[0].hash, 'string');
    assert.equal(tail.entries[0].hash.length, 64);
    assert.equal(tail.nextSince, null); // last page (no cap)
    s.close();
  } finally { cleanup(h); }
});

test('since() with limit returns at most `limit` and exposes nextSince cursor', () => {
  const h = tmpDb();
  try {
    const s = new SqlChain({ file: h.file });
    for (let i = 1; i <= 7; i++) s.append({ i });
    const p1 = s.since(0, { limit: 3 });
    assert.equal(p1.entries.length, 3);
    assert.deepStrictEqual(p1.entries.map((e) => e.seq), [1, 2, 3]);
    assert.equal(p1.nextSince, 3);
    const p2 = s.since(p1.nextSince, { limit: 3 });
    assert.equal(p2.entries.length, 3);
    assert.equal(p2.nextSince, 6);
    const tail = s.since(p2.nextSince, { limit: 100 });
    assert.equal(tail.entries.length, 1);
    assert.equal(tail.nextSince, null);
    s.close();
  } finally { cleanup(h); }
});

test('reopen preserves history, chainId, and head hash', () => {
  const h = tmpDb();
  try {
    const a = new SqlChain({ file: h.file });
    a.append({ msg: 'first' });
    a.append({ msg: 'second' });
    const cidA = a.chainId;
    const headA = a.head.hash;
    a.close();

    const b = new SqlChain({ file: h.file });
    assert.equal(b.chainId, cidA);
    assert.equal(b.head.hash, headA);
    assert.equal(b.verify().length, 3);
    // Append on the reopened chain must continue the same chain.
    const e = b.append({ msg: 'third' });
    assert.equal(e.prevHash, headA);
    b.close();
  } finally { cleanup(h); }
});

test('WAL journal mode is enabled on the connection', () => {
  const h = tmpDb();
  try {
    const s = new SqlChain({ file: h.file });
    s.append({ ping: true });
    s.close();
    const probe = new SqlChain({ file: h.file });
    // journal_mode is a string-valued PRAGMA; read it via a prepared SELECT
    // (db.exec() does not surface result rows; db.pragma() is not available
    // on this node:sqlite build).
    const row = probe.db.prepare('PRAGMA journal_mode').get();
    probe.close();
    assert.equal(String(row.journal_mode).toLowerCase(), 'wal', `journal_mode should be WAL, got ${row.journal_mode}`);
  } finally { cleanup(h); }
});

test('verify() detects payload tampering (fail closed)', () => {
  const h = tmpDb();
  try {
    const s = new SqlChain({ file: h.file });
    s.append({ v: 1 });
    s.append({ v: 2 });
    s.close();

    const probe = new SqlChain({ file: h.file });
    probe.db.prepare('UPDATE chain_entries SET payload = ? WHERE seq = 1').run('{"v":999}');
    probe.close();

    const verify = new SqlChain({ file: h.file });
    const v = verify.verify();
    assert.equal(v.ok, false);
    assert.equal(v.reason, 'hash_mismatch');
    verify.close();
  } finally { cleanup(h); }
});

test('fts flag is a boolean; when fts5 is available, content is searchable', () => {
  const h = tmpDb();
  try {
    const s = new SqlChain({ file: h.file });
    assert.equal(typeof s.fts, 'boolean');
    if (s.fts) {
      // FTS5 IS available on this host (Node 24 + node:sqlite built with fts5).
      // The fts virtual table should exist; append a payload and query it.
      s.append({ tool: 'shell.run', bot: 'forge', cmd: 'ls' });
      const rows = s.db
        .prepare("SELECT rowid FROM chain_fts WHERE chain_fts MATCH ?")
        .all('shell');
      assert.ok(rows.length >= 1, 'fts should find the inserted token');
    }
    // When fts5 is NOT compiled, the constructor must set s.fts=false and
    // leave the chain fully functional. The branch above is simply skipped.
    s.close();
  } finally { cleanup(h); }
});

test('explicit chainId is honored on a fresh db', () => {
  const h = tmpDb();
  try {
    const cid = '11111111-2222-3333-4444-555555555555';
    const s = new SqlChain({ file: h.file, chainId: cid, genesisTs: 1700000000000 });
    assert.equal(s.chainId, cid);
    assert.equal(s.entries[0].payload.chainId, cid);
    s.close();
  } finally { cleanup(h); }
});
