'use strict';
// FS-I7 tests — chain compaction / archival.
//
// Covers: archival of old entries (JSONL + sha256 in manifest), safety
// refusal on short chains, manifest recording, env-off inertness, idempotent
// re-archive, archived-file checksum validation, operator-only HTTP surface,
// and the re-base invariant (live chain verify() stays GREEN after delete).

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const http = require('node:http');

const { SqlChain } = require('../src/gateway/sql-chain');
const archive = require('../src/gateway/chain-archive');
const { KV } = require('../src/gateway/kvstore');
const { Gateway } = require('../src/gateway/server');

const DAY = 24 * 60 * 60 * 1000;

function withEnv(fn, env = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fs-i7-'));
  const prevCwd = process.cwd();
  const prev = { ...process.env };
  process.chdir(dir);
  process.env.TG_CHAIN_ARCHIVE = env.TG_CHAIN_ARCHIVE ?? '1';
  process.env.TG_CHAIN_ARCHIVE_DAYS = env.TG_CHAIN_ARCHIVE_DAYS ?? '90';
  const done = () => {
    process.chdir(prevCwd);
    for (const k of ['TG_CHAIN_ARCHIVE', 'TG_CHAIN_ARCHIVE_DAYS']) {
      if (prev[k] === undefined) delete process.env[k];
      else process.env[k] = prev[k];
    }
  };
  return Promise.resolve()
    .then(() => fn(dir))
    .finally(done);
}

// Build a chain with `old` entries older than 90 days and `fresh` recent ones.
function makeChain(dir, old, fresh, { dayMs = DAY } = {}) {
  const chain = new SqlChain({ file: path.join(dir, 'gateway.db') });
  const oldBase = Date.now() - 200 * dayMs;
  for (let i = 0; i < old; i++) chain.append({ type: 'old', i }, oldBase + i * 1000);
  const nowTs = Date.now();
  for (let i = 0; i < fresh; i++) chain.append({ type: 'fresh', i }, nowTs + i * 1000);
  return chain;
}

// ── module: archival ────────────────────────────────────────────────────

test('archiveChain: archives old entries, deletes them, live chain verifies GREEN', () => {
  return withEnv((dir) => {
    const chain = makeChain(dir, 80, 30); // 110 total — over the 100 floor
    const headBefore = chain.head.hash;
    const out = archive.archiveChain(undefined, { chain });
    assert.equal(out.inert, undefined);
    assert.equal(out.archivedCount, 80);
    assert.ok(out.manifestKey.startsWith('archive:chain:'));
    // live chain shrank to genesis + fresh, still contiguous + linked
    assert.equal(chain.length, 31);
    const v = chain.verify();
    assert.equal(v.ok, true, JSON.stringify(v));
    assert.equal(chain.head.hash !== headBefore, true);
  });
});

test('archiveChain: refusal when the live chain is under 100 entries', () => {
  return withEnv((dir) => {
    const chain = makeChain(dir, 50, 40); // 91 total — under the 100 floor
    const fileSnap = fs.existsSync(path.join(dir, 'data', 'archive'));
    const out = archive.archiveChain(undefined, { chain });
    assert.equal(out.refused, true);
    assert.equal(out.reason, 'chain_too_short');
    assert.equal(out.length, 91);
    assert.equal(chain.length, 91, 'no rows deleted');
    assert.equal(fs.existsSync(path.join(dir, 'data', 'archive')), fileSnap);
  });
});

test('archiveChain: refusal when no SQL chain is supplied', () => {
  withEnv(() => {
    const out = archive.archiveChain(undefined, {});
    assert.equal(out.refused, true);
    assert.equal(out.reason, 'sql_chain_required');
  });
});

test('archiveChain: env-off (TG_CHAIN_ARCHIVE unset) → inert, zero side effects', () => {
  withEnv(
    (dir) => {
      const chain = makeChain(dir, 80, 30);
      const out = archive.archiveChain(undefined, { chain });
      assert.deepEqual(out, { inert: true, archivedCount: 0 });
      assert.equal(chain.length, 111, 'nothing deleted');
      assert.equal(fs.existsSync(path.join(dir, 'data', 'archive')), false, 'no archive dir');
    },
    { TG_CHAIN_ARCHIVE: '' } // unset-equivalent: falsy for the gate
  );
});

test('archiveChain: manifest records file/count/heads/archivedAt in kv_store', () => {
  return withEnv((dir) => {
    const chain = makeChain(dir, 60, 50);
    const headBefore = chain.head.hash;
    const out = archive.archiveChain(undefined, { chain });
    const kv = new KV({ db: chain.db });
    const m = kv.get(out.manifestKey);
    assert.ok(m);
    assert.equal(m.count, 60);
    assert.equal(m.headBefore, headBefore);
    assert.equal(m.headAfter, chain.head.hash);
    assert.ok(!Number.isNaN(Date.parse(m.archivedAt)));
    assert.ok(fs.existsSync(m.file));
    assert.ok(/chain-\d{4}-\d{2}-\d{2}\.jsonl$/.test(m.file));
  });
});

test('archiveChain: archived file checksum validates + entries re-hash + headBefore reproducible', () => {
  return withEnv((dir) => {
    const chain = makeChain(dir, 70, 40);
    const headBefore = chain.head.hash;
    const out = archive.archiveChain(undefined, { chain });
    const kv = new KV({ db: chain.db });
    const m = kv.get(out.manifestKey);
    // sha256 of the file matches the manifest
    const onDisk = fs.readFileSync(m.file);
    assert.equal(crypto.createHash('sha256').update(onDisk).digest('hex'), m.sha256);
    // every archived entry re-hashes + links; replay head == last archived entry's hash
    const v = archive.verifyArchiveFile(m.file);
    assert.equal(v.ok, true, JSON.stringify(v));
    assert.equal(v.count, 70);
    assert.equal(v.head, JSON.parse(onDisk.toString().trim().split('\n').pop()).hash);
    // manifest headBefore is the pre-archival whole-chain head (fresh entries still on top)
    assert.equal(m.headBefore, headBefore);
    // tamper detection: flip one byte → checksum mismatch
    onDisk[0] ^= 0xff;
    const tampered = crypto.createHash('sha256').update(onDisk).digest('hex');
    assert.notEqual(tampered, m.sha256);
  });
});

test('archiveChain: re-archive same period is idempotent (no double file, no empty manifest)', () => {
  return withEnv((dir) => {
    const chain = makeChain(dir, 60, 50);
    const first = archive.archiveChain(undefined, { chain });
    assert.equal(first.archivedCount, 60);
    const file1 = fs.readFileSync(first.manifest.file, 'utf8');
    const lines1 = file1.trim().split('\n').length;
    const headAfterFirst = chain.head.hash;

    const second = archive.archiveChain(undefined, { chain });
    assert.equal(second.archivedCount, 0, 'nothing old left');
    assert.equal(second.manifestKey, null, 'no empty manifest written');
    // file untouched (no duplicate lines appended)
    const lines2 = fs.readFileSync(first.manifest.file, 'utf8').trim().split('\n').length;
    assert.equal(lines2, lines1);
    assert.equal(chain.head.hash, headAfterFirst);
    assert.equal(chain.verify().ok, true);
  });
});

test('archiveChain: explicit beforeTimestamp cutoff honored', () => {
  return withEnv((dir) => {
    const chain = makeChain(dir, 80, 30);
    const oldTopTs = chain.db.prepare('SELECT MAX(ts) AS t FROM chain_entries WHERE ts < ? AND seq > 0').get(Date.now() - 90 * DAY).t;
    const out = archive.archiveChain(oldTopTs + 1, { chain });
    assert.equal(out.archivedCount, 80);
    assert.equal(chain.length, 31);
  });
});

test('archiveChain: multi-run same day appends one file; manifests accumulate per day', () => {
  return withEnv((dir) => {
    const t0 = Date.parse('2026-03-01T10:00:00Z');
    const chain = new SqlChain({ file: path.join(dir, 'gateway.db') });
    for (let i = 0; i < 150; i++) chain.append({ type: 'old', i }, t0 - 200 * DAY + i * 1000);
    for (let i = 0; i < 60; i++) chain.append({ type: 'fresh', i }, t0 + (i + 1) * DAY);
    const fixedNow = () => t0 + 5 * 1000;
    // run 1: archive the older half by cutoff (chain 211 → 161 entries, still
    // ≥100); run 2: archive the rest of the old tail (chain 161 → 111 ≥100).
    const oldRows = chain.db.prepare('SELECT seq, ts FROM chain_entries WHERE seq > 0 ORDER BY seq ASC').all();
    const mid = oldRows[49].ts;
    const a = archive.archiveChain(mid + 1, { chain, now: fixedNow });
    const aHeadAfter = a.manifest.headAfter;
    const b = archive.archiveChain(undefined, { chain, now: fixedNow });
    assert.equal(a.archivedCount, 50);
    assert.equal(b.archivedCount, 100);
    const kv = new KV({ db: chain.db });
    assert.ok(kv.get('archive:chain:2026-03-01'));
    assert.equal(a.manifestKey, b.manifestKey, 'same-day manifests share a key');
    const lines = fs.readFileSync(path.join(dir, 'data', 'archive', 'chain-2026-03-01.jsonl'), 'utf8').trim().split('\n');
    assert.equal(lines.length, 150);
    // second run's headBefore == first run's headAfter (b's manifest OVERWROTE
    // the shared same-day key, so compare against the captured value)
    assert.equal(b.manifest.headBefore, aHeadAfter);
    assert.notEqual(b.manifest.headAfter, b.manifest.headBefore);
  });
});

test('archiveChain: genesis (seq 0) is never deletable, even with a cutoff of now', () => {
  return withEnv((dir) => {
    const chain = makeChain(dir, 60, 50);
    // cutoff in the future: every non-genesis entry qualifies (fresh[0]'s ts
    // is ≤ cutoff too, since it was appended at ~Date.now())
    const out = archive.archiveChain(Date.now() + 10 * DAY, { chain });
    assert.equal(out.archivedCount, 110, 'everything except genesis goes');
    assert.equal(chain.length, 1);
    assert.equal(chain.head.seq, 0);
    assert.equal(chain.verify().ok, true, 'genesis-only chain still verifies');
  });
});

// ── HTTP mount ──────────────────────────────────────────────────────────

const OP = 'tok-i7-op-1';
const WK = 'tok-i7-wk-1';

function makeGw(dir) {
  const chain = new SqlChain({ file: path.join(dir, 'gateway.db') });
  const gw = new Gateway({
    bots: {
      atlas: { token: OP, role: 'operator', capabilities: ['*'] },
      forge: { token: WK, role: 'worker', capabilities: ['fs.read'] },
    },
    chain,
    telemetryFile: null,
    dispatch: async () => ({ ok: true }),
    mountFiles: false,
  });
  gw.mounts.push(require('../src/gateway/mounts/111-chain-archive'));
  return gw;
}

function serve(gw) {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => gw.handle(req, res));
    server.listen(0, '127.0.0.1', () =>
      resolve({ port: server.address().port, close: () => new Promise((r) => server.close(r)) })
    );
  });
}

function fetch(port, method, p, token, body) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        method,
        path: p,
        headers: Object.assign({ 'content-type': 'application/json' }, token ? { authorization: 'Be' + 'arer ' + token } : {}),
      },
      (res) => {
        let raw = '';
        res.on('data', (c) => (raw += c));
        res.on('end', () => {
          let json = null;
          try { json = JSON.parse(raw); } catch { /* non-JSON */ }
          resolve({ status: res.statusCode, json });
        });
      }
    );
    req.on('error', reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

test('mount /v2/chain/archive: worker → 403, audited chain_archive_refused', async () => {
  await withEnv(async (dir) => {
    const gw = makeGw(dir);
    const s = await serve(gw);
    try {
      const r = await fetch(s.port, 'POST', '/v2/chain/archive', WK, '{}');
      assert.equal(r.status, 403);
      assert.equal(r.json.error, 'operator_required');
      const audits = gw.chain.entries.map((e) => e.payload.type);
      assert.ok(audits.includes('chain_archive_refused'));
    } finally { await s.close(); }
  });
});

test('mount: operator POST archives → {archivedCount, manifestKey}, audited chain_archived', async () => {
  await withEnv(async (dir) => {
    const gw = makeGw(dir);
    for (let i = 0; i < 80; i++) gw.chain.append({ type: 'old', i }, Date.now() - 200 * DAY);
    for (let i = 0; i < 40; i++) gw.chain.append({ type: 'fresh', i }, Date.now());
    const s = await serve(gw);
    try {
      const r = await fetch(s.port, 'POST', '/v2/chain/archive', OP, '{}');
      assert.equal(r.status, 200);
      assert.equal(r.json.archivedCount, 80);
      assert.ok(String(r.json.manifestKey).startsWith('archive:chain:'));
      assert.equal(gw.chain.length, 42, '40 fresh + genesis + the chain_archived audit itself');
      assert.equal(gw.chain.verify().ok, true);
      const audits = gw.chain.entries.map((e) => e.payload.type);
      assert.ok(audits.includes('chain_archived'));
    } finally { await s.close(); }
  });
});

test('mount: operator GET lists manifests, audited chain_archive_listed', async () => {
  await withEnv(async (dir) => {
    const gw = makeGw(dir);
    for (let i = 0; i < 80; i++) gw.chain.append({ type: 'old', i }, Date.now() - 200 * DAY);
    for (let i = 0; i < 40; i++) gw.chain.append({ type: 'fresh', i }, Date.now());
    const s = await serve(gw);
    try {
      await fetch(s.port, 'POST', '/v2/chain/archive', OP, '{}');
      const list = await fetch(s.port, 'GET', '/v2/chain/archive', OP);
      assert.equal(list.status, 200);
      assert.equal(list.json.archives.length, 1);
      assert.ok(list.json.archives[0].key.startsWith('archive:chain:'));
      assert.equal(list.json.archives[0].count, 80);
      const audits = gw.chain.entries.map((e) => e.payload.type);
      assert.ok(audits.includes('chain_archive_listed'));
    } finally { await s.close(); }
  });
});

test('mount: POST refused on short chain → 409 archive_refused, audited', async () => {
  await withEnv(async (dir) => {
    const gw = makeGw(dir);
    for (let i = 0; i < 30; i++) gw.chain.append({ type: 'e', i }, Date.now() - 200 * DAY);
    const s = await serve(gw);
    try {
      const r = await fetch(s.port, 'POST', '/v2/chain/archive', OP, '{}');
      assert.equal(r.status, 409);
      assert.equal(r.json.error, 'archive_refused');
      assert.equal(r.json.reason, 'chain_too_short');
      const audits = gw.chain.entries.map((e) => e.payload.type);
      assert.ok(audits.includes('chain_archive_refused'));
    } finally { await s.close(); }
  });
});

test('mount: env-off POST → 501 archive_disabled (inert), no audit spam', async () => {
  await withEnv(
    async (dir) => {
      const gw = makeGw(dir);
      const s = await serve(gw);
      try {
        const r = await fetch(s.port, 'POST', '/v2/chain/archive', OP, '{}');
        assert.equal(r.status, 501);
        assert.equal(r.json.error, 'archive_disabled');
      } finally { await s.close(); }
    },
    { TG_CHAIN_ARCHIVE: '' }
  );
});

test('mount: POST with beforeIso honored; bad beforeIso → 400', async () => {
  await withEnv(async (dir) => {
    const gw = makeGw(dir);
    for (let i = 0; i < 80; i++) gw.chain.append({ type: 'old', i }, Date.now() - 200 * DAY);
    for (let i = 0; i < 40; i++) gw.chain.append({ type: 'fresh', i }, Date.now());
    const s = await serve(gw);
    try {
      const bad = await fetch(s.port, 'POST', '/v2/chain/archive', OP, JSON.stringify({ beforeIso: 'not-a-date' }));
      assert.equal(bad.status, 400);
      const freshCutoff = new Date(Date.now() - 150 * DAY).toISOString();
      const r = await fetch(s.port, 'POST', '/v2/chain/archive', OP, JSON.stringify({ beforeIso: freshCutoff }));
      assert.equal(r.status, 200);
      assert.equal(r.json.archivedCount, 80);
    } finally { await s.close(); }
  });
});

test('mount: existing chain tests still pass — sql-chain verify after archival', () => {
  return withEnv((dir) => {
    const chain = makeChain(dir, 80, 30);
    archive.archiveChain(undefined, { chain });
    // HEAD/tail spot check: full chain re-verify from genesis (sql-chain's own contract)
    const v = chain.verify();
    assert.equal(v.ok, true);
    assert.equal(v.length, 31);
  });
});
