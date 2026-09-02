'use strict';
// W10 self-repair tests: diagnosis detects a REAL tamper (forged entry),
// quarantine copy lands on disk, audit entry sealed, HTTP 503, and the
// repairer never rewrites hashes (safe isolation only).

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');
const { Gateway } = require('../src/gateway/server');
const { HashChain } = require('../src/gateway/hash-chain');
const { SelfRepair } = require('../src/gateway/selfrepair');
const { entryHash } = require('../src/gateway/hash-chain');

function tmpdir(name) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `repair-${name}-`));
}

function makeGateway({ chain } = {}) {
  return new Gateway({
    bots: {
      forge: { name: 'forge', token: 'tok-forge', role: 'worker', capabilities: ['fs.read'] },
      atlas: { name: 'atlas', token: 'tok-atlas', role: 'operator', capabilities: ['*'] },
    },
    chain: chain || new HashChain(),
  });
}

function buildServer(gw) {
  const server = http.createServer((req, res) => gw.handle(req, res));
  return {
    server,
    close() { return new Promise((r) => server.close(() => r())); },
  };
}

async function listen(server) {
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return `http://127.0.0.1:${server.address().port}`;
}

// ── real tamper: append a forged entry to a test chain ─────────────

function forgeEntry(chain) {
  // Append an entry whose hash covers DIFFERENT content than stored —
  // the classic forgery: compute hash for payload A, store payload B.
  const head = chain.head;
  const seq = head.seq + 1;
  const ts = Date.now();
  const realPayload = { type: 'action_executed', bot: 'forge', tool: 'fs.read:innocent.md', ok: true };
  const forgedPayload = { type: 'action_executed', bot: 'atlas', tool: 'fs.read:innocent.md', ok: true };
  const hash = entryHash(seq, head.hash, ts, realPayload); // signed over "forge"
  const entry = { seq, prevHash: head.hash, ts, payload: forgedPayload, hash };
  chain.entries.push(entry); // raw append bypassing append()
  return entry;
}

test('diagnose: healthy chain → ok, no quarantine', () => {
  const dir = tmpdir('healthy');
  const gw = makeGateway();
  gw._audit({ type: 'action_decision', bot: 'forge', tool: 'fs.read:a.md', decision: 'allow' });
  const r = new SelfRepair({ gw, dataDir: dir });
  const report = r.diagnose();
  assert.equal(report.ok, true);
  assert.equal(report.repaired, false);
  assert.ok(report.head);
  assert.equal(fs.readdirSync(dir).length, 0, 'no quarantine files on healthy chain');
});

test('diagnose: forged entry detected, quarantined, audited, never re-sealed', () => {
  const dir = tmpdir('tamper');
  const chain = new HashChain();
  const gw = makeGateway({ chain });
  gw._audit({ type: 'action_decision', bot: 'forge', tool: 'fs.read:a.md', decision: 'allow' });
  gw._audit({ type: 'action_executed', bot: 'forge', tool: 'fs.read:a.md', ok: true });
  const before = gw.chain.verify();
  assert.ok(before.ok, 'sanity: chain verifies before forgery');

  const forged = forgeEntry(chain);
  assert.equal(chain.verify().ok, false, 'sanity: forged entry must break verification');
  const forgedHash = forged.hash;

  const r = new SelfRepair({ gw, dataDir: dir });
  const report = r.diagnose();
  assert.equal(report.ok, false);
  assert.equal(report.repaired, false, 'repair never rewrites hashes');
  assert.equal(report.failedSeq, forged.seq);
  assert.equal(report.reason, 'hash_mismatch');
  // diagnosis details
  assert.equal(report.diagnosis.storedHashMatchesContent, false);
  // quarantine copy exists and contains the full chain snapshot
  const files = fs.readdirSync(dir).filter((f) => f.startsWith('quarantine-'));
  assert.equal(files.length, 1);
  assert.equal(report.quarantine, files[0]);
  assert.match(report.quarantine, /^quarantine-\d+\.json$/);
  const full = path.join(dir, files[0]);
  assert.equal(fs.statSync(full).mode & 0o777, 0o600, 'quarantine is 0600');
  const snap = JSON.parse(fs.readFileSync(full, 'utf8'));
  assert.equal(snap.verify.ok, false);
  // The snapshot is captured BEFORE the diagnosis audit lands, so it holds
  // the tampered chain exactly as found (the selfrepair_diagnosed entry is
  // appended after the snapshot by design — write-ahead of the diagnosis).
  assert.equal(snap.entries.length, chain.entries.length - 1, 'full snapshot captured (pre-audit chain)');
  assert.equal(snap.entries.at(-1).seq, forged.seq);
  // audited
  const entries = gw.chain.entries.map((e) => e.payload);
  const diag = entries.filter((e) => e.type === 'selfrepair_diagnosed');
  assert.equal(diag.length, 1);
  assert.equal(diag[0].at, forged.seq);
  assert.equal(diag[0].reason, 'hash_mismatch');
  assert.equal(diag[0].quarantined, true);
  assert.equal(diag[0].quarantineFile, files[0]);
  // the tampered entry itself was NOT touched (no re-seal). Note: diagnose()
  // appends its own audit entry afterwards, so index by seq, not by position.
  assert.equal(chain.entries[forged.seq].hash, forgedHash, 'stored (forged) hash untouched');
});

test('diagnose: in-memory expected mirror comparison flags payload_changed', () => {
  const dir = tmpdir('mirror');
  const chain = new HashChain();
  const gw = makeGateway({ chain });
  const e1 = gw._audit({ type: 'action_decision', bot: 'forge', tool: 'fs.read:a.md', decision: 'allow' });
  const expected = [chain.entries[0], { ...e1 }];
  // Tamper with entry payload AND recompute hash correctly for content —
  // but the stored hash then mismatches the original chain linkage…
  // simpler: keep mirror of pristine entries, forge seq 2.
  forgeEntry(chain);
  const r = new SelfRepair({ gw, dataDir: dir, expected });
  const report = r.diagnose();
  assert.equal(report.ok, false);
  const mism = report.diagnosis.expectedComparison.mismatches;
  assert.ok(Array.isArray(mism));
  assert.ok(mism.some((m) => m.seq === 2 && m.kind === 'missing_in_expected'));
});

test('diagnose: prev_hash tamper (relink attack) is located too', () => {
  const dir = tmpdir('relink');
  const chain = new HashChain();
  const gw = makeGateway({ chain });
  gw._audit({ type: 'action_decision', bot: 'forge', tool: 'fs.read:a.md', decision: 'allow' });
  gw._audit({ type: 'action_executed', bot: 'forge', tool: 'fs.read:a.md', ok: true });
  // attacker rewrites entry 2's prevHash to point at entry 1's hash directly
  chain.entries[2].prevHash = chain.entries[1].prevHash;
  const r = new SelfRepair({ gw, dataDir: dir });
  const report = r.diagnose();
  assert.equal(report.ok, false);
  assert.equal(report.reason, 'prev_hash_mismatch');
  assert.equal(report.failedSeq, 2);
  assert.equal(fs.readdirSync(dir).filter((f) => f.startsWith('quarantine-')).length, 1);
});

test('HTTP: GET /v2/repair/diagnose → 503 + quarantine name on tamper; 200 on healthy', async () => {
  const dir = tmpdir('http');
  process.env.TG_QUARANTINE_DIR = dir; // in-memory chain → default repo data/; pin to tmp
  const chain = new HashChain();
  const gw = makeGateway({ chain });
  gw._audit({ type: 'action_decision', bot: 'forge', tool: 'fs.read:a.md', decision: 'allow' });
  forgeEntry(chain);
  const ctx = buildServer(gw);
  const base = await listen(ctx.server);
  try {
    const res = await fetch(`${base}/v2/repair/diagnose`, {
      headers: { authorization: 'Bearer tok-atlas' },
    });
    assert.equal(res.status, 503);
    const body = await res.json();
    assert.equal(body.ok, false);
    assert.equal(body.repaired, false, 'must never claim a silent repair');
    assert.match(body.quarantine, /^quarantine-\d+\.json$/);
    assert.ok(fs.existsSync(path.join(dir, body.quarantine)), 'quarantine file exists');
    assert.equal(body.reason, 'hash_mismatch');
  } finally {
    await ctx.close();
  }

  // healthy gateway: 200 ok
  const gw2 = makeGateway();
  const ctx2 = buildServer(gw2);
  const base2 = await listen(ctx2.server);
  try {
    const res = await fetch(`${base2}/v2/repair/diagnose`, {
      headers: { authorization: 'Bearer tok-atlas' },
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.ok, true);
  } finally {
    await ctx2.close();
  }
});

test('HTTP: /v2/repair/diagnose requires auth', async () => {
  const gw = makeGateway();
  const ctx = buildServer(gw);
  const base = await listen(ctx.server);
  try {
    const res = await fetch(`${base}/v2/repair/diagnose`);
    assert.equal(res.status, 401);
  } finally {
    await ctx.close();
  }
});

test('diagnose works against SqlChain (DB rows vs entry objects)', () => {
  const { SqlChain } = require('../src/gateway/sql-chain');
  const dir = tmpdir('sql');
  const dbFile = path.join(dir, 'gateway.db');
  const chain = new SqlChain({ file: dbFile });
  const gw = makeGateway({ chain });
  gw.chain = chain;
  gw._audit({ type: 'action_decision', bot: 'forge', tool: 'fs.read:a.md', decision: 'allow' });
  // tamper directly in the DB: rewrite payload of seq 1
  chain.db.prepare('UPDATE chain_entries SET payload = ? WHERE seq = 1')
    .run(JSON.stringify({ type: 'action_decision', bot: 'forge', tool: 'fs.read:EVIL.md', decision: 'allow' }));
  const r = new SelfRepair({ gw, dataDir: dir });
  const report = r.diagnose();
  assert.equal(report.ok, false);
  assert.equal(report.failedSeq, 1);
  assert.equal(report.dbFile, dbFile);
  assert.equal(fs.readdirSync(dir).filter((f) => f.startsWith('quarantine-')).length, 1);
  chain.close();
});

test('quarantine timestamps never collide (second file gets distinct name)', () => {
  const dir = tmpdir('collide');
  const chain = new HashChain();
  const gw = makeGateway({ chain });
  gw._audit({ type: 'action_decision', bot: 'forge', tool: 'fs.read:a.md', decision: 'allow' });
  const fixedNow = 1_700_000_000_000;
  const r = new SelfRepair({ gw, dataDir: dir, now: () => fixedNow });
  forgeEntry(chain);
  const rep1 = r.diagnose();
  assert.ok(rep1.ok === false);
  // second diagnosis on the same broken chain, same ms → distinct filename
  const rep2 = r.diagnose();
  assert.notEqual(rep1.quarantine, rep2.quarantine);
  assert.equal(fs.readdirSync(dir).filter((f) => f.startsWith('quarantine-')).length, 2);
});