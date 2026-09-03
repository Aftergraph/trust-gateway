'use strict';
// FS-J3 tests — archive restore drill.
//
// Covers: archive→restore roundtrip (verify GREEN, head updated), duplicate-
// skip idempotency (restore twice → second is a clean no-op), checksum-
// mismatch refusal, missing-manifest refusal, bloat-guard refusal, operator-
// scoped HTTP surface (worker → 403, audited), and env-off inertness.

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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fs-j3-'));
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
function makeChain(dir, old, fresh) {
  const chain = new SqlChain({ file: path.join(dir, 'gateway.db') });
  const oldBase = Date.now() - 200 * DAY;
  for (let i = 0; i < old; i++) chain.append({ type: 'old', i }, oldBase + i * 1000);
  const nowTs = Date.now();
  for (let i = 0; i < fresh; i++) chain.append({ type: 'fresh', i }, nowTs + i * 1000);
  return chain;
}

// Archive `old` entries and return {chain, manifestKey}.
function archiveOld(dir, old, fresh) {
  const chain = makeChain(dir, old, fresh);
  const out = archive.archiveChain(undefined, { chain });
  assert.equal(out.archivedCount, old, 'setup: archival worked');
  return { chain, manifestKey: out.manifestKey };
}

// ── module: restoreArchive ──────────────────────────────────────────────

test('restoreArchive: archive→restore roundtrip — entries back, verify GREEN, head updated', () => {
  return withEnv((dir) => {
    const { chain, manifestKey } = archiveOld(dir, 80, 40);
    const headAfterArchive = chain.head.hash;
    assert.equal(chain.length, 41, 'genesis + fresh only after archival');

    const r = archive.restoreArchive(manifestKey, { chain });
    assert.equal(r.restoredCount, 80);
    assert.equal(r.skippedDuplicates, 0);
    assert.ok(r.newHead, 'returns the new head');
    assert.equal(chain.length, 121, '41 + 80 restored');
    assert.equal(chain.head.hash, r.newHead);
    assert.notEqual(chain.head.hash, headAfterArchive, 'head moved');
    const v = chain.verify();
    assert.equal(v.ok, true, JSON.stringify(v));
    // every restored payload made it back (content identity)
    const types = chain.entries.map((e) => e.payload.type);
    assert.equal(types.filter((t) => t === 'old').length, 80);
    assert.equal(types.filter((t) => t === 'fresh').length, 40);
  });
});

test('restoreArchive: duplicate-skip idempotency — second restore restores nothing, chain unchanged', () => {
  return withEnv((dir) => {
    const { chain, manifestKey } = archiveOld(dir, 60, 50);
    const first = archive.restoreArchive(manifestKey, { chain });
    assert.equal(first.restoredCount, 60);
    const lenAfterFirst = chain.length;
    const headAfterFirst = chain.head.hash;

    const second = archive.restoreArchive(manifestKey, { chain });
    assert.equal(second.restoredCount, 0, 'nothing restored on re-run');
    assert.equal(second.skippedDuplicates, 60, 'every archived entry was a duplicate');
    assert.equal(chain.length, lenAfterFirst, 'no rows added');
    assert.equal(chain.head.hash, headAfterFirst, 'head unchanged');
    assert.equal(chain.verify().ok, true);
    // a THIRD run behaves identically (stable no-op)
    const third = archive.restoreArchive(manifestKey, { chain });
    assert.deepEqual([third.restoredCount, third.skippedDuplicates], [0, 60]);
  });
});

test('restoreArchive: checksum mismatch REFUSES (throws) and leaves the live chain untouched', () => {
  return withEnv((dir) => {
    const { chain, manifestKey } = archiveOld(dir, 50, 60);
    const kv = new KV({ db: chain.db });
    const m = kv.get(manifestKey);
    const lenBefore = chain.length;
    const headBefore = chain.head.hash;

    // flip one byte on disk → checksum no longer matches the manifest
    const raw = fs.readFileSync(m.file);
    raw[0] ^= 0xff;
    fs.writeFileSync(m.file, raw);

    assert.throws(
      () => archive.restoreArchive(manifestKey, { chain }),
      (e) => e.code === 'checksum_mismatch' && /sha256 mismatch/.test(e.message)
    );
    assert.equal(chain.length, lenBefore, 'live DB untouched');
    assert.equal(chain.head.hash, headBefore, 'head untouched');
  });
});

test('restoreArchive: missing manifest REFUSES (throws manifest_missing)', () => {
  return withEnv((dir) => {
    const chain = makeChain(dir, 10, 5);
    assert.throws(
      () => archive.restoreArchive('archive:chain:1999-01-01', { chain }),
      (e) => e.code === 'manifest_missing'
    );
    // wrong-shape key is also refused, before any disk access
    assert.throws(
      () => archive.restoreArchive('../etc/passwd', { chain }),
      (e) => e.code === 'invalid_manifest_key'
    );
    // manifest present but archive file deleted → honest refusal
    // (fresh subdir so the db doesn't carry the earlier chain's rows)
    const sub = fs.mkdtempSync(path.join(os.tmpdir(), 'fs-j3-file-'));
    const { chain: subChain, manifestKey } = archiveOld(sub, 40, 70);
    const kv = new KV({ db: subChain.db });
    const m = kv.get(manifestKey);
    fs.rmSync(m.file);
    assert.throws(
      () => archive.restoreArchive(manifestKey, { chain: subChain }),
      (e) => e.code === 'archive_file_missing'
    );
  });
});

test('restoreArchive: bloat guard REFUSES when live >1000 and restore would push past 10000', () => {
  return withEnv((dir) => {
    const chain = new SqlChain({ file: path.join(dir, 'gateway.db') });
    // seed a big old tail, archive it away, then re-grow the live chain past 1000.
    // Guard arithmetic: live (9500) + archive (3000) = 12500 > 10000 → refuse.
    for (let i = 0; i < 3000; i++) chain.append({ type: 'old', i }, Date.now() - 200 * DAY);
    for (let i = 0; i < 20; i++) chain.append({ type: 'fresh', i }, Date.now());
    const out = archive.archiveChain(undefined, { chain });
    assert.equal(out.archivedCount, 3000);
    assert.equal(chain.length, 21);
    for (let i = 0; i < 9500; i++) chain.append({ type: 'live', i }, Date.now() + i);

    const r = archive.restoreArchive(out.manifestKey, { chain });
    assert.equal(r.refused, true);
    assert.equal(r.reason, 'bloat_guard');
    assert.equal(r.archiveEntries, 3000);
    assert.equal(chain.length, 9521, 'nothing inserted');
    assert.equal(chain.verify().ok, true);
  });
});

test('restoreArchive: bloat guard does NOT fire when the restore stays under the cap', () => {
  return withEnv((dir) => {
    const chain = new SqlChain({ file: path.join(dir, 'gateway.db') });
    for (let i = 0; i < 3000; i++) chain.append({ type: 'old', i }, Date.now() - 200 * DAY);
    for (let i = 0; i < 20; i++) chain.append({ type: 'fresh', i }, Date.now());
    const out = archive.archiveChain(undefined, { chain });
    assert.equal(out.archivedCount, 3000);
    // live (950) + archive (3000) = 3950 < 10000 → restore proceeds
    for (let i = 0; i < 950; i++) chain.append({ type: 'live', i }, Date.now() + i);
    const r = archive.restoreArchive(out.manifestKey, { chain });
    assert.equal(r.refused, undefined, 'no bloat-guard refusal');
    assert.equal(r.restoredCount, 3000);
    assert.equal(chain.verify().ok, true);
  });
});

test('restoreArchive: env-off (TG_CHAIN_ARCHIVE unset) → inert, zero side effects', () => {
  return withEnv(
    (dir) => {
      const chain = makeChain(dir, 20, 10);
      const before = chain.length;
      const r = archive.restoreArchive('archive:chain:2026-01-01', { chain });
      assert.deepEqual(r, { inert: true, restoredCount: 0, skippedDuplicates: 0 });
      assert.equal(chain.length, before, 'nothing read, nothing written');
    },
    { TG_CHAIN_ARCHIVE: '' }
  );
});

// ── HTTP mount: operator-scoped restore surface ─────────────────────────

const OP = 'tok-j3-op-1';
const WK = 'tok-j3-wk-1';

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

test('mount: operator restore drill over HTTP — GET manifest details, POST restore → 200 + chain_restored', async () => {
  await withEnv(async (dir) => {
    const gw = makeGw(dir);
    for (let i = 0; i < 70; i++) gw.chain.append({ type: 'old', i }, Date.now() - 200 * DAY);
    for (let i = 0; i < 40; i++) gw.chain.append({ type: 'fresh', i }, Date.now());
    const s = await serve(gw);
    try {
      const a = await fetch(s.port, 'POST', '/v2/chain/archive', OP, '{}');
      assert.equal(a.status, 200);
      const key = a.json.manifestKey; // archive:chain:<date>
      const seg = key.replace('archive:chain:', '');

      // GET manifest details BEFORE restore
      const detail = await fetch(s.port, 'GET', `/v2/chain/archive/${seg}`, OP);
      assert.equal(detail.status, 200);
      assert.equal(detail.json.key, key);
      assert.equal(detail.json.count, 70);
      assert.ok(detail.json.sha256);
      assert.equal(detail.json.restoreEndpoint, `/v2/chain/archive/${seg}/restore`);

      // restore
      const r = await fetch(s.port, 'POST', `/v2/chain/archive/${seg}/restore`, OP, '{}');
      assert.equal(r.status, 200);
      assert.equal(r.json.restoredCount, 70);
      assert.equal(r.json.skippedDuplicates, 0);
      assert.ok(r.json.newHead);
      assert.equal(gw.chain.verify().ok, true);

      const audits = gw.chain.entries.map((e) => e.payload.type);
      assert.ok(audits.includes('chain_restored'));
      // idempotent second restore over HTTP → 200 with skippedDuplicates
      const r2 = await fetch(s.port, 'POST', `/v2/chain/archive/${seg}/restore`, OP, '{}');
      assert.equal(r2.status, 200);
      assert.equal(r2.json.restoredCount, 0);
      assert.equal(r2.json.skippedDuplicates, 70);
    } finally { await s.close(); }
  });
});

test('mount: worker restore attempt → 403 operator_required, audited chain_archive_refused', async () => {
  await withEnv(async (dir) => {
    const gw = makeGw(dir);
    const s = await serve(gw);
    try {
      const r = await fetch(s.port, 'POST', '/v2/chain/archive/2026-09-03/restore', WK, '{}');
      assert.equal(r.status, 403);
      assert.equal(r.json.error, 'operator_required');
      const d = await fetch(s.port, 'GET', '/v2/chain/archive/2026-09-03', WK);
      assert.equal(d.status, 403);
      const audits = gw.chain.entries.map((e) => e.payload.type);
      assert.ok(audits.includes('chain_archive_refused'));
      assert.ok(!audits.includes('chain_restored'));
    } finally { await s.close(); }
  });
});

test('mount: restore refuses missing manifest → 409 + chain_restore_refused audit', async () => {
  await withEnv(async (dir) => {
    const gw = makeGw(dir);
    const s = await serve(gw);
    try {
      const r = await fetch(s.port, 'POST', '/v2/chain/archive/1999-01-01/restore', OP, '{}');
      assert.equal(r.status, 409);
      assert.equal(r.json.error, 'restore_refused');
      assert.equal(r.json.reason, 'manifest_missing');
      const audits = gw.chain.entries.map((e) => e.payload.type);
      assert.ok(audits.includes('chain_restore_refused'));
    } finally { await s.close(); }
  });
});

test('mount: bloat-guard refusal over HTTP → 409 bloat_guard + audited chain_restore_refused', async () => {
  await withEnv(async (dir) => {
    const gw = makeGw(dir);
    for (let i = 0; i < 3000; i++) gw.chain.append({ type: 'old', i }, Date.now() - 200 * DAY);
    for (let i = 0; i < 20; i++) gw.chain.append({ type: 'fresh', i }, Date.now());
    const s = await serve(gw);
    try {
      const a = await fetch(s.port, 'POST', '/v2/chain/archive', OP, '{}');
      assert.equal(a.json.archivedCount, 3000);
      const seg = a.json.manifestKey.replace('archive:chain:', '');
      // guard arithmetic: live (9500) + archive (3000) = 12500 > 10000
      for (let i = 0; i < 9500; i++) gw.chain.append({ type: 'live', i }, Date.now() + i);
      const r = await fetch(s.port, 'POST', `/v2/chain/archive/${seg}/restore`, OP, '{}');
      assert.equal(r.status, 409);
      assert.equal(r.json.reason, 'bloat_guard');
      const audits = gw.chain.entries.map((e) => e.payload.type);
      assert.ok(audits.includes('chain_restore_refused'));
    } finally { await s.close(); }
  });
});

test('mount: restore with env-off → 501 archive_disabled (inert)', async () => {
  await withEnv(
    async (dir) => {
      const gw = makeGw(dir);
      const s = await serve(gw);
      try {
        const r = await fetch(s.port, 'POST', '/v2/chain/archive/2026-09-03/restore', OP, '{}');
        assert.equal(r.status, 501);
        assert.equal(r.json.error, 'archive_disabled');
        const audits = gw.chain.entries.map((e) => e.payload.type);
        assert.ok(!audits.includes('chain_restored'));
      } finally { await s.close(); }
    },
    { TG_CHAIN_ARCHIVE: '' }
  );
});

test('mount: GET unknown manifest → 404 manifest_not_found', async () => {
  await withEnv(async (dir) => {
    const gw = makeGw(dir);
    const s = await serve(gw);
    try {
      const r = await fetch(s.port, 'GET', '/v2/chain/archive/1999-01-01', OP);
      assert.equal(r.status, 404);
      assert.equal(r.json.error, 'manifest_not_found');
    } finally { await s.close(); }
  });
});
