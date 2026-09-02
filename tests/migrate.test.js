'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { HashChain } = require('../src/gateway/hash-chain');

const REPO = path.resolve(__dirname, '..');
const MIGRATE = path.join(REPO, 'bin', 'migrate-v2.js');

function makeWorkdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'migrate-test-'));
}

function rmWorkdir(dir) {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
}

function writeJsonl(file, entries) {
  const text = entries.map((e) => JSON.stringify(e)).join('\n') + '\n';
  fs.writeFileSync(file, text);
}

function writeApprovals(file, rows) {
  fs.writeFileSync(file, JSON.stringify(rows));
}

function runMigrate({ jsonl, approvals, db, force = false, extraEnv = {} }) {
  const args = [MIGRATE];
  if (jsonl) args.push('--jsonl', jsonl);
  if (approvals) args.push('--approvals', approvals);
  if (db) args.push('--db', db);
  if (force) args.push('--force');
  return spawnSync(process.execPath, args, {
    encoding: 'utf8',
    env: { ...process.env, ...extraEnv },
  });
}

test('builds a 5-entry JSONL chain via HashChain and migrates → db verifies, head matches', () => {
  const dir = makeWorkdir();
  try {
    const jsonl = path.join(dir, 'audit.jsonl');
    const approvals = path.join(dir, 'approvals.json');
    const db = path.join(dir, 'gateway.db');

    const h = new HashChain();
    for (let i = 1; i <= 5; i++) {
      h.append({ kind: 'exec', n: i, payload: `step-${i}` });
    }
    writeJsonl(jsonl, h.entries);
    writeApprovals(approvals, [
      {
        id: 'apr_1', bot: 'forge', tool: 'shell.run',
        args: { cmd: 'ls' }, argsSummary: '{"cmd":"ls"}',
        status: 'pending', createdAt: 100, expiresAt: 200,
        resolvedBy: null, resolvedAt: null,
      },
      {
        id: 'apr_2', bot: 'sage', tool: 'fs.read',
        args: { path: '/x' }, argsSummary: '{"path":"/x"}',
        status: 'approved', createdAt: 110, expiresAt: 210,
        resolvedBy: 'op-1', resolvedAt: 150,
      },
    ]);

    const res = runMigrate({ jsonl, approvals, db });
    assert.equal(res.status, 0, `migrate must exit 0; stderr:\n${res.stderr}`);
    const out = JSON.parse(res.stdout.trim());
    assert.equal(out.migrated, true);
    assert.equal(out.entries, h.entries.length);
    assert.equal(out.head, h.head.hash);
    assert.equal(out.chainId, h.chainId);
    assert.equal(out.approvals, 2);
    assert.equal(fs.existsSync(db), true);

    // Probe the db: verify and count approvals.
    const probe = spawnSync(process.execPath, ['-e',
      `const {SqlChain}=require(${JSON.stringify(path.join(REPO, 'src/gateway/sql-chain'))});
       const c=new SqlChain({file:${JSON.stringify(db)}});
       const v=c.verify();
       const ap=c.db.prepare('SELECT COUNT(*) AS n FROM approvals').get();
       const apRow=c.db.prepare('SELECT * FROM approvals WHERE id=?').get('apr_2');
       process.stdout.write(JSON.stringify({v, ap, apRow}));
       c.close();`], { encoding: 'utf8' });
    assert.equal(probe.status, 0, `probe must succeed; stderr:\n${probe.stderr}`);
    const probeData = JSON.parse(probe.stdout);
    assert.equal(probeData.v.ok, true);
    assert.equal(probeData.v.head, h.head.hash);
    assert.equal(probeData.v.length, h.entries.length);
    assert.equal(probeData.ap.n, 2);
    assert.equal(probeData.apRow.status, 'approved');
    assert.equal(probeData.apRow.resolved_by, 'op-1');
  } finally { rmWorkdir(dir); }
});

test('tampered JSONL → migrate refuses, exit non-zero, no db file left', () => {
  const dir = makeWorkdir();
  try {
    const jsonl = path.join(dir, 'audit.jsonl');
    const approvals = path.join(dir, 'approvals.json');
    const db = path.join(dir, 'gateway.db');

    const h = new HashChain();
    for (let i = 1; i <= 4; i++) h.append({ n: i });
    const entries = h.entries.slice();
    // Tamper: change the payload of seq 2 — its stored hash will no longer match.
    entries[2] = { ...entries[2], payload: { n: 999 } };
    writeJsonl(jsonl, entries);
    writeApprovals(approvals, []);

    const res = runMigrate({ jsonl, approvals, db });
    assert.notEqual(res.status, 0, `migrate must exit non-zero; stdout:\n${res.stdout}\nstderr:\n${res.stderr}`);
    assert.match(res.stderr, /hash mismatch/i);
    // No db file (or sidecars) should remain after a failed migration.
    assert.equal(fs.existsSync(db), false, 'db file must be removed on failure');
    assert.equal(fs.existsSync(db + '-wal'), false, 'db-wal must be removed on failure');
    assert.equal(fs.existsSync(db + '-shm'), false, 'db-shm must be removed on failure');
  } finally { rmWorkdir(dir); }
});

test('idempotent re-run with matching JSONL skips (skipped:true) and exits 0', () => {
  const dir = makeWorkdir();
  try {
    const jsonl = path.join(dir, 'audit.jsonl');
    const approvals = path.join(dir, 'approvals.json');
    const db = path.join(dir, 'gateway.db');

    const h = new HashChain();
    for (let i = 1; i <= 3; i++) h.append({ n: i });
    writeJsonl(jsonl, h.entries);
    writeApprovals(approvals, []);

    const first = runMigrate({ jsonl, approvals, db });
    assert.equal(first.status, 0, `first migrate must exit 0; stderr:\n${first.stderr}`);
    const firstOut = JSON.parse(first.stdout.trim());
    assert.equal(firstOut.migrated, true);

    const second = runMigrate({ jsonl, approvals, db });
    assert.equal(second.status, 0, `second migrate must exit 0; stderr:\n${second.stderr}`);
    const secondOut = JSON.parse(second.stdout.trim());
    assert.equal(secondOut.skipped, true);
    assert.equal(secondOut.already, 'up-to-date');
    assert.equal(secondOut.entries, h.entries.length);
    assert.equal(secondOut.head, h.head.hash);
    assert.equal(secondOut.chainId, h.chainId);

    // The db file should still be present (we did not wipe on skip).
    assert.equal(fs.existsSync(db), true);
  } finally { rmWorkdir(dir); }
});

test('approvals rows are imported with identical column semantics', () => {
  const dir = makeWorkdir();
  try {
    const jsonl = path.join(dir, 'audit.jsonl');
    const approvals = path.join(dir, 'approvals.json');
    const db = path.join(dir, 'gateway.db');

    const h = new HashChain();
    h.append({ ping: 1 });
    writeJsonl(jsonl, h.entries);

    const apvRows = [
      { id: 'a', bot: 'forge', tool: 'shell.run', args: { cmd: 'whoami' },
        argsSummary: '{"cmd":"whoami"}', status: 'pending',
        createdAt: 1000, expiresAt: 2000, resolvedBy: null, resolvedAt: null },
      { id: 'b', bot: 'sage',  tool: 'fs.delete', args: { path: '/tmp/x' },
        argsSummary: '{"path":"/tmp/x"}', status: 'denied',
        createdAt: 1500, expiresAt: 2500, resolvedBy: 'op-9', resolvedAt: 1700 },
    ];
    writeApprovals(approvals, apvRows);

    const res = runMigrate({ jsonl, approvals, db });
    assert.equal(res.status, 0, `migrate must exit 0; stderr:\n${res.stderr}`);

    const probe = spawnSync(process.execPath, ['-e',
      `const {SqlChain}=require(${JSON.stringify(path.join(REPO, 'src/gateway/sql-chain'))});
       const c=new SqlChain({file:${JSON.stringify(db)}});
       const rows=c.db.prepare('SELECT * FROM approvals ORDER BY id').all();
       process.stdout.write(JSON.stringify(rows));
       c.close();`], { encoding: 'utf8' });
    assert.equal(probe.status, 0, `probe must succeed; stderr:\n${probe.stderr}`);
    const rows = JSON.parse(probe.stdout);
    assert.equal(rows.length, 2);
    const a = rows.find((r) => r.id === 'a');
    const b = rows.find((r) => r.id === 'b');
    assert.equal(a.bot, 'forge');
    assert.equal(a.status, 'pending');
    assert.equal(a.created_at, 1000);
    assert.equal(a.expires_at, 2000);
    assert.equal(a.resolved_by, null);
    assert.equal(a.resolved_at, null);
    // args may be serialized as JSON string (object form) or stored as a string.
    const aArgs = typeof a.args === 'string' ? JSON.parse(a.args) : a.args;
    assert.deepStrictEqual(aArgs, { cmd: 'whoami' });
    assert.equal(b.status, 'denied');
    assert.equal(b.resolved_by, 'op-9');
    assert.equal(b.resolved_at, 1700);
  } finally { rmWorkdir(dir); }
});
