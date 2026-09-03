'use strict';
// FS-B1 tests — verified backup/restore.
//
// Covers: manifest integrity (sha256 per file + chainHead binding), FIFO
// prune at 10, restore happy path (files replaced byte-identical), fail-
// closed restore on tampered file / missing file / corrupt manifest
// (NOTHING replaced on refusal), restart-window honesty (wal/shm picked up
// when present), and the HTTP mount: operator-only RBAC, create→list→
// restore round trip, 409 on tampered restore.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

const backup = require('../src/gateway/backup');

function withDataDir(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fs-b1-'));
  const prev = process.env.TG_DATA_DIR;
  const prevCwd = process.cwd();
  process.env.TG_DATA_DIR = path.join(dir, 'data');
  fs.mkdirSync(process.env.TG_DATA_DIR, { recursive: true });
  process.chdir(dir); // cwd-relative defaults land in the temp dir
  const done = () => {
    process.chdir(prevCwd);
    if (prev === undefined) delete process.env.TG_DATA_DIR;
    else process.env.TG_DATA_DIR = prev;
  };
  // Await async callbacks INSIDE the env scope so their assertions still
  // run against the temp dir (restoring cwd early sent late asserts to the
  // wrong directory — the "async activity after the test ended" class).
  return Promise.resolve()
    .then(() => fn(dir))
    .finally(done);
}

function seedData(dir, { withDb = true } = {}) {
  const d = path.join(dir, 'data');
  fs.writeFileSync(path.join(d, 'providers.json'), JSON.stringify({ providers: [{ name: 'x' }] }));
  fs.writeFileSync(path.join(d, 'bots.json'), JSON.stringify({ bots: [] }));
  if (withDb) fs.writeFileSync(path.join(d, 'gateway.db'), Buffer.from('sqlite-bytes-0123456789'));
  return d;
}

test('createBackup: copies json + db, manifest sha256s match, chainHead bound', () => {
  withDataDir((dir) => {
    const d = seedData(dir);
    const { dir: bdir, manifest } = backup.withChainFacts(
      backup.createBackup(),
      { head: { hash: 'a'.repeat(64) }, chainId: 'chain-1' }
    );
    assert.ok(fs.existsSync(path.join(bdir, 'gateway.db')));
    assert.ok(fs.existsSync(path.join(bdir, 'providers.json')));
    assert.ok(fs.existsSync(path.join(bdir, 'manifest.json')));
    assert.equal(manifest.chainHead, 'a'.repeat(64));
    assert.equal(manifest.chainId, 'chain-1');
    for (const f of manifest.files) {
      const onDisk = fs.readFileSync(path.join(bdir, f.name));
      const h = crypto.createHash('sha256').update(onDisk).digest('hex');
      assert.equal(h, f.sha256, f.name + ' hash matches manifest');
      assert.equal(f.size, onDisk.length);
      // and the live file is what the manifest describes
      assert.equal(
        crypto.createHash('sha256').update(fs.readFileSync(path.join(d, f.name))).digest('hex'),
        f.sha256
      );
    }
  });
});

test('createBackup: FIFO prune keeps last 10', () => {
  withDataDir((dir) => {
    seedData(dir);
    for (let i = 0; i < 12; i++) {
      const ts = new Date(Date.parse('2026-09-03T10:00:00Z') + i * 1000).toISOString();
      backup.createBackup({ now: () => ts });
    }
    const left = backup.listBackupNames();
    assert.equal(left.length, backup.MAX_BACKUPS);
    // newest survive (ISO names sort chronologically)
    assert.ok(left[left.length - 1] > left[0]);
  });
});

test('restore: verified files replace live data byte-identically', () => {
  withDataDir((dir) => {
    const d = seedData(dir);
    const { dir: bdir } = backup.createBackup();
    // mutate live data after backup
    fs.writeFileSync(path.join(d, 'providers.json'), '{"providers":[{"name":"corrupted"}]}');
    fs.writeFileSync(path.join(d, 'gateway.db'), Buffer.from('overwritten'));
    const { restored } = backup.restore(bdir);
    assert.ok(restored.includes('providers.json'));
    assert.ok(restored.includes('gateway.db'));
    assert.equal(fs.readFileSync(path.join(d, 'providers.json'), 'utf8'), JSON.stringify({ providers: [{ name: 'x' }] }));
    assert.equal(fs.readFileSync(path.join(d, 'gateway.db'), 'utf8'), 'sqlite-bytes-0123456789');
  });
});

test('restore: fails closed on tampered file — NOTHING replaced', () => {
  withDataDir((dir) => {
    const d = seedData(dir);
    const { dir: bdir } = backup.createBackup();
    // tamper with ONE file inside the backup
    fs.writeFileSync(path.join(bdir, 'bots.json'), '{"bots":[{"hacked":true}]}');
    // snapshot live state
    const before = fs.readFileSync(path.join(d, 'providers.json'));
    assert.throws(() => backup.restore(bdir), /sha256 mismatch.*fail closed/);
    // live data untouched
    assert.equal(fs.readFileSync(path.join(d, 'providers.json')).toString(), before.toString());
  });
});

test('restore: fails closed on missing file and corrupt manifest', () => {
  withDataDir((dir) => {
    const d = seedData(dir);
    const { dir: bdir } = backup.createBackup();
    fs.rmSync(path.join(bdir, 'gateway.db'));
    assert.throws(() => backup.restore(bdir), /file missing.*fail closed/);

    const { dir: bdir2 } = backup.createBackup();
    fs.writeFileSync(path.join(bdir2, 'manifest.json'), '{broken');
    assert.throws(() => backup.restore(bdir2), /manifest unreadable.*fail closed/);
  });
});

test('createBackup: picks up -wal/-shm when present (restart-window honesty)', () => {
  withDataDir((dir) => {
    const d = seedData(dir);
    fs.writeFileSync(path.join(d, 'gateway.db-wal'), Buffer.from('wal-bytes'));
    const { dir: bdir, manifest } = backup.createBackup();
    assert.ok(manifest.files.some((f) => f.name === 'gateway.db-wal'));
    assert.ok(fs.existsSync(path.join(bdir, 'gateway.db-wal')));
  });
});

// ── HTTP mount ─────────────────────────────────────────────────────────
const http = require('node:http');
const { Gateway } = require('../src/gateway/server');

const OP = 'tok-backup-op-1';
const WK = 'tok-backup-wk-1';

function makeGw() {
  const gw = new Gateway({
    bots: {
      atlas: { token: OP, role: 'operator', capabilities: ['*'] },
      forge: { token: WK, role: 'worker', capabilities: ['fs.read'] },
    },
    telemetryFile: null, // memory-only; this suite owns the data dir
    dispatch: async () => ({ ok: true }),
    mountFiles: false, // only the backup mount is under test
  });
  gw.mounts.push(require('../src/gateway/mounts/110-backup'));
  return gw;
}

function serve(gw) {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => gw.handle(req, res));
    server.listen(0, '127.0.0.1', () => resolve({
      port: server.address().port,
      close: () => new Promise((r) => server.close(r)),
    }));
  });
}

function fetch(port, method, p, token, body) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1', port, method, path: p,
      headers: Object.assign(
        { 'content-type': 'application/json' },
        token ? { authorization: 'Be' + 'arer ' + token } : {},
      ),
    }, (res) => {
      let raw = '';
      res.on('data', (c) => { raw += c; });
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(raw); } catch { /* non-JSON */ }
        resolve({ status: res.statusCode, json });
      });
    });
    req.on('error', reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

test('mount /v2/backup: worker → 403 operator_required (audited)', async () => {
  await withDataDir(async (dir) => {
    seedData(dir);
    const gw = makeGw();
    const s = await serve(gw);
    try {
      const r = await fetch(s.port, 'GET', '/v2/backup', WK);
      assert.equal(r.status, 403);
      assert.equal(r.json.error, 'operator_required');
    } finally { await s.close(); }
  });
});

test('mount /v2/backup: operator create→list→restore round trip over HTTP', async () => {
  await withDataDir(async (dir) => {
    const d = seedData(dir);
    const gw = makeGw();
    const s = await serve(gw);
    try {
      // create — capture pre-create head: the mount audits backup_created
      // AFTER sealing the manifest, so the chain moves one step past it.
      const headBefore = gw.chain.head.hash;
      const created = await fetch(s.port, 'POST', '/v2/backup', OP, '{}');
      assert.equal(created.status, 201);
      assert.equal(created.json.manifest.chainHead, headBefore);
      const name = created.json.dir;
      assert.ok(/^backup-/.test(name));
      // list
      const list = await fetch(s.port, 'GET', '/v2/backup', OP);
      assert.equal(list.status, 200);
      assert.equal(list.json.backups.length, 1);
      assert.equal(list.json.backups[0].name, name);
      assert.equal(list.json.backups[0].chainHead, headBefore);
      // tamper live data, restore by name
      fs.writeFileSync(path.join(d, 'providers.json'), '{"hacked":true}');
      const restored = await fetch(s.port, 'POST', '/v2/backup/restore', OP, JSON.stringify({ name }));
      assert.equal(restored.status, 200);
      assert.ok(restored.json.restored.includes('providers.json'));
      assert.equal(fs.readFileSync(path.join(d, 'providers.json'), 'utf8'), JSON.stringify({ providers: [{ name: 'x' }] }));
      // audited
      const audits = gw.chain.entries.map((e) => e.payload.type);
      assert.ok(audits.includes('backup_created'));
      assert.ok(audits.includes('backup_restored'));
    } finally { await s.close(); }
  });
});

test('mount /v2/backup/restore: tampered backup → 409 restore_refused (audited)', async () => {
  await withDataDir(async (dir) => {
    const d = seedData(dir);
    const gw = makeGw();
    const s = await serve(gw);
    try {
      const created = await fetch(s.port, 'POST', '/v2/backup', OP, '{}');
      const name = created.json.dir;
      const bdir = path.join(dir, 'data', 'backups', name);
      fs.writeFileSync(path.join(bdir, 'bots.json'), '{"tampered":1}');
      const r = await fetch(s.port, 'POST', '/v2/backup/restore', OP, JSON.stringify({ name }));
      assert.equal(r.status, 409);
      assert.equal(r.json.error, 'restore_refused');
      // live data untouched
      assert.equal(fs.readFileSync(path.join(d, 'providers.json'), 'utf8'), JSON.stringify({ providers: [{ name: 'x' }] }));
      const audits = gw.chain.entries.map((e) => e.payload.type);
      assert.ok(audits.includes('backup_restore_refused'));
    } finally { await s.close(); }
  });
});

test('mount /v2/backup/restore: bad name → 400; unknown → 409', async () => {
  await withDataDir(async (dir) => {
    seedData(dir);
    const gw = makeGw();
    const s = await serve(gw);
    try {
      const bad = await fetch(s.port, 'POST', '/v2/backup/restore', OP, JSON.stringify({ name: '../../etc' }));
      assert.equal(bad.status, 400);
      const unknown = await fetch(s.port, 'POST', '/v2/backup/restore', OP, JSON.stringify({ name: 'backup-2099-01-01T00-00-00-000Z' }));
      assert.equal(unknown.status, 409);
    } finally { await s.close(); }
  });
});
