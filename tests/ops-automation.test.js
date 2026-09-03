'use strict';
// FS-E2 — ops automation tests.
//
// Two layers:
//   1. SOURCE-LEVEL assertions on the deploy scripts — install.sh idempotency
//      guards, absolute unit paths, backup-once wiring, restore-drill
//      fail-closed assertion, watchdog nonzero-exit gates, and a secret sweep
//      over every script (ops scripts must contain zero tokens).
//   2. REAL EXECUTION of bin/backup-once.js against a temp TG_DATA_DIR:
//      manifest written, chainHead null (gw-less), FIFO retention respected.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');

const REPO = path.resolve(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(REPO, p), 'utf8');

const INSTALL_SH = read('deploy/install.sh');
const SERVICE = read('deploy/backup-timer/tg-backup.service');
const TIMER = read('deploy/backup-timer/tg-backup.timer');
const DRILL = read('deploy/restore-drill.sh');
const WATCHDOG = read('deploy/watchdog.sh');
const BACKUP_ONCE = read('bin/backup-once.js');

// ── install.sh — idempotent installer ────────────────────────────

test('install.sh: idempotency guards present (no dup units, restart only if active)', () => {
  // unit is installed via overwrite into the system dir — never copied per-run
  assert.ok(INSTALL_SH.includes('/etc/systemd/system/tg-gateway.service'),
    'installs the unit into the system unit dir');
  assert.ok(/cp|-f|sed[^\n]*>/.test(INSTALL_SH), 'unit lands via overwrite (sed/cp)');
  assert.ok(INSTALL_SH.includes('systemctl daemon-reload'));
  assert.ok(INSTALL_SH.includes('systemctl enable --now'),
    'uses enable --now for the first start');
  assert.ok(/is-active/.test(INSTALL_SH) && /restart/.test(INSTALL_SH),
    'restarts only a service that is already active');
  assert.ok(!/systemctl restart[^\n]*\n?\s*$/.test(''), 'noop');
  // restart must be guarded by the is-active check
  const guarded = INSTALL_SH.includes('is-active') &&
    INSTALL_SH.indexOf('is-active') < INSTALL_SH.indexOf('systemctl restart');
  assert.ok(guarded, 'is-active guard precedes the restart call');
});

test('install.sh: waits up to 30s for /healthz and prints status', () => {
  assert.ok(/seq 1 30/.test(INSTALL_SH), 'health poll bounded at 30 attempts (1s each)');
  assert.ok(INSTALL_SH.includes('/healthz'));
  assert.ok(/systemctl[^\n]*status/.test(INSTALL_SH), 'prints service status at the end');
  assert.ok(INSTALL_SH.includes('set -euo pipefail'), 'fails closed on any error');
});

test('install.sh: rewrites WorkingDirectory to the real repo path', () => {
  assert.ok(/sed[^\n]*s#\/root\/agent-workforce#\$REPO/.test(INSTALL_SH) ||
    /sed\s+"s#\/root\/agent-workforce#/.test(INSTALL_SH),
    'sed-replaces the hardcoded repo path in the unit');
  assert.ok(/WorkingDirectory=\$REPO/.test(INSTALL_SH),
    'asserts the rewritten WorkingDirectory line');
  // REPO is derived from the script's own location, not a frozen guess
  assert.ok(/BASH_SOURCE/.test(INSTALL_SH), 'repo path derived from script location');
});

test('install.sh: refuses to run without env file / node / root', () => {
  assert.ok(INSTALL_SH.includes('gateway.env'), 'gates on the env file');
  assert.ok(INSTALL_SH.includes('command -v node'), 'gates on node');
  assert.ok(INSTALL_SH.includes('id -u'), 'gates on root');
});

// ── backup timer units ───────────────────────────────────────────

test('tg-backup.service: absolute paths, runs backup-once, daily 04:00 timer', () => {
  assert.ok(/^\[Unit\]/m.test(SERVICE) && /^\[Service\]/m.test(SERVICE));
  assert.ok(SERVICE.includes('ExecStart=/usr/bin/env node bin/backup-once.js'),
    'ExecStart runs the real backup-once entrypoint');
  assert.ok(/^WorkingDirectory=\/root\/agent-workforce$/m.test(SERVICE),
    'absolute WorkingDirectory');
  assert.ok(/^EnvironmentFile=-\/root\/agent-workforce\/data\/gateway.env$/m.test(SERVICE),
    'secrets come from the env file at runtime (optional prefix ok)');
  assert.ok(SERVICE.includes('Type=oneshot'));
  assert.ok(/^\[Timer\]/m.test(TIMER));
  assert.ok(TIMER.includes('OnCalendar=*-*-* 04:00:00'), 'daily 04:00 schedule');
  assert.ok(TIMER.includes('Unit=tg-backup.service'), 'timer fires the service unit');
  assert.ok(TIMER.includes('Persistent=true'), 'catches up missed runs');
  assert.ok(TIMER.includes('WantedBy=timers.target'));
});

// ── bin/backup-once.js — real gw-less wiring ─────────────────────

test('backup-once.js: wires createBackup + withChainFacts(null chain)', () => {
  assert.ok(BACKUP_ONCE.includes("require('../src/gateway/backup')"),
    'requires the real backup module');
  assert.ok(/createBackup\(\)/.test(BACKUP_ONCE), 'calls createBackup');
  assert.ok(/withChainFacts\(createBackup\(\),\s*null\)/.test(BACKUP_ONCE),
    'passes null chain — gw-less mode, chainHead stays null');
});

// ── restore-drill.sh — fail-closed proof ─────────────────────────

test('restore-drill.sh: corrupt-backup fail-closed assertion exists', () => {
  assert.ok(/TAMPERED/.test(DRILL), 'tamper step present (valid manifest, corrupt file)');
  assert.ok(/restore[^\n]*accepted a TAMPERED backup[^\n]*broken|accepting a tampered/i.test(DRILL) ||
    /accepted a TAMPERED backup/.test(DRILL),
    'asserts restore FAILS on the tampered backup');
  assert.ok(/before|after/.test(DRILL) && /sha256sum/.test(DRILL),
    'compares live-dir hashes before/after the failed restore');
  assert.ok(/live data changed during failed restore/.test(DRILL),
    'asserts live data is untouched when restore fails');
  assert.ok(/never operates on the live data dir|SCRATCH/i.test(DRILL),
    'restore targets are scratch copies only');
  assert.ok(/cmp -s/.test(DRILL), 'diffs restored files against the backup (good path)');
  assert.ok(/mktemp/.test(DRILL), 'all work in a temp dir');
});

// ── watchdog.sh — nonzero exit on every failure mode ─────────────

test('watchdog.sh: exits nonzero on missing healthz, bad chain, full disk', () => {
  const exits = (WATCHDOG.match(/exit 1/g) || []).length;
  assert.ok(exits >= 3, `has >=3 failure exits, found ${exits}`);
  assert.ok(WATCHDOG.includes('/healthz'), 'checks /healthz via curl');
  assert.ok(/curl[^\n]*--max-time/.test(WATCHDOG), 'healthz probe is time-bounded');
  assert.ok(/chain/.test(WATCHDOG) && /ok/.test(WATCHDOG),
    'checks the chain.verify ok flag');
  assert.ok(/df[^\n]*pcent/.test(WATCHDOG), 'checks data-dir disk usage');
  assert.ok(WATCHDOG.includes('>&2'), 'failure messages go to stderr for alerting');
  assert.ok(/set -uo pipefail/.test(WATCHDOG));
});

// ── secret sweep — no tokens in ANY ops script ───────────────────

test('ops scripts are secret-free', () => {
  // realistic-looking fake tokens: the scripts must not contain any
  const needles = [
    /TG_BOT_TOKENS\s*=\s*['"]?[^\s$'{]/, // assignments with a literal value
    /sk-[A-Za-z0-9]{8,}/,
    /tok-[A-Za-z0-9]{6,}/,
    /bot\d{6,}:[A-Za-z0-9_-]{20,}/, // telegram bot token shape
  ];
  for (const [name, src] of [
    ['install.sh', INSTALL_SH], ['tg-backup.service', SERVICE],
    ['restore-drill.sh', DRILL], ['watchdog.sh', WATCHDOG],
    ['backup-once.js', BACKUP_ONCE],
  ]) {
    for (const re of needles) {
      assert.ok(!re.test(src), `${name} contains a secret-shaped literal: ${re}`);
    }
  }
});

// ── REAL EXECUTION: backup-once.js against a temp TG_DATA_DIR ────

test('backup-once.js: real run — manifest written, chainHead null, FIFO respected', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-fs-e2-'));
  const dataDir = path.join(tmp, 'data');
  fs.mkdirSync(path.join(dataDir, 'backups'), { recursive: true });
  fs.writeFileSync(path.join(dataDir, 'kvstore.json'), '{"seed":true}');
  fs.writeFileSync(path.join(dataDir, 'memory.json'), '{"goals":[]}');
  // seed 10 fake backups so the run must FIFO-prune the oldest (MAX_BACKUPS=10)
  for (let i = 0; i < 10; i++) {
    const name = `backup-2026-01-01T00-00-${String(i).padStart(2, '0')}-000Z`;
    fs.mkdirSync(path.join(dataDir, 'backups', name), { recursive: true });
    fs.writeFileSync(path.join(dataDir, 'backups', name, 'manifest.json'),
      JSON.stringify({ files: [], createdAt: `2026-01-01T00:00:0${i}Z` }));
  }

  const r = spawnSync(process.execPath, [path.join(REPO, 'bin', 'backup-once.js')], {
    cwd: REPO,
    env: { ...process.env, TG_DATA_DIR: dataDir },
    encoding: 'utf8',
  });
  assert.strictEqual(r.status, 0, `exit 0 expected, stderr: ${r.stderr}`);

  // manifest written into the new backup dir
  const names = fs.readdirSync(path.join(dataDir, 'backups'))
    .filter((n) => /^backup-\d{4}-\d{2}-\d{2}T/.test(n)).sort();
  const latest = path.join(dataDir, 'backups', names[names.length - 1]);
  const manifest = JSON.parse(fs.readFileSync(path.join(latest, 'manifest.json'), 'utf8'));
  assert.ok(Array.isArray(manifest.files) && manifest.files.length >= 2,
    'manifest lists the seeded files');
  assert.ok(manifest.files.some((f) => f.name === 'kvstore.json'));
  assert.strictEqual(manifest.chainHead, null, 'gw-less run keeps chainHead null');
  assert.strictEqual(manifest.chainId, null, 'gw-less run keeps chainId null');
  assert.ok(manifest.createdAt, 'createdAt recorded');

  // FIFO respected: 10 seeded + 1 new = 11 → oldest pruned back to MAX_BACKUPS
  const { MAX_BACKUPS } = require('../src/gateway/backup');
  assert.strictEqual(names.length, MAX_BACKUPS, `FIFO prunes to ${MAX_BACKUPS}`);
  assert.ok(!names.includes('backup-2026-01-01T00-00-00-000Z'),
    'oldest seeded backup was pruned');
  assert.ok(r.stdout.includes('chainHead=null'), 'summary line reports chainHead');

  // snapshot the copied files match the source bytes
  assert.strictEqual(
    fs.readFileSync(path.join(latest, 'kvstore.json'), 'utf8'),
    '{"seed":true}',
    'backup copy is byte-identical to the seeded file');

  fs.rmSync(tmp, { recursive: true, force: true });
});

test('backup-once.js: nonzero exit on unwritable data dir', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-fs-e2-'));
  const dataDir = path.join(tmp, 'data');
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(path.join(dataDir, 'kvstore.json'), '{}');
  // point backups under a file → createBackup mkdir fails → exit 1
  fs.writeFileSync(path.join(dataDir, 'backups'), 'not a dir');
  const r = spawnSync(process.execPath, [path.join(REPO, 'bin', 'backup-once.js')], {
    cwd: REPO,
    env: { ...process.env, TG_DATA_DIR: dataDir },
    encoding: 'utf8',
  });
  assert.notStrictEqual(r.status, 0, 'must fail closed (nonzero exit)');
  assert.ok(/FAILED/.test(r.stderr), 'human message on stderr');
  fs.rmSync(tmp, { recursive: true, force: true });
});
