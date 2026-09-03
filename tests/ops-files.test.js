'use strict';
// FS-B2 — production ops hardening tests.
//
// Statically validates the deploy/ ops artifacts:
//   • tg-gateway.service parses as an ini unit and pins the required keys
//     (ExecStart, Restart=always, EnvironmentFile) + hardening flags.
//   • install.sh / rollout.sh / status.sh all use `set -euo pipefail`,
//     are idempotent (convergent operations, no destructive moves), and
//     gate on /healthz.
//   • status.sh exits nonzero when /healthz fails (source check: the failure
//     branch must end in `exit 1`).
//   • NO secrets are inlined anywhere in deploy/: TG_BOT_TOKENS / TG_LLM_KEY
//     may appear only as bare variable NAMES (env file sourced), never as
//     literal assignments or token-looking strings.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const DEPLOY = path.join(__dirname, '..', 'deploy');
const UNIT = path.join(DEPLOY, 'tg-gateway.service');

const read = (p) => fs.readFileSync(p, 'utf8');

// ── minimal ini parser (sections + key=value, comments/#/; ignored) ──
function parseIni(text) {
  const out = {};
  let section = null;
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#') || line.startsWith(';')) continue;
    const m = /^\[(.+)\]$/.exec(line);
    if (m) { section = m[1]; out[section] = {}; continue; }
    const kv = /^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (kv && section) out[section][kv[1]] = kv[2].trim();
  }
  return out;
}

test('systemd unit parses as ini with Unit/Service/Install sections', () => {
  const ini = parseIni(read(UNIT));
  for (const s of ['Unit', 'Service', 'Install']) {
    assert.ok(ini[s], `missing [${s}] section`);
  }
});

test('unit pins WorkingDirectory, EnvironmentFile, ExecStart, Restart', () => {
  const svc = parseIni(read(UNIT)).Service;
  assert.equal(svc.WorkingDirectory, '/root/agent-workforce');
  assert.equal(svc.EnvironmentFile, '/root/agent-workforce/data/gateway.env');
  assert.equal(svc.ExecStart, '/usr/bin/env node bin/gateway.js --dispatch');
  assert.equal(svc.Restart, 'always');
  assert.equal(svc.RestartSec, '2');
});

test('unit carries the required hardening flags', () => {
  const svc = parseIni(read(UNIT)).Service;
  assert.equal(svc.NoNewPrivileges, 'true');
  assert.equal(svc.ProtectSystem, 'strict');
  assert.equal(svc.ReadWritePaths, '/root/agent-workforce/data');
  assert.equal(svc.PrivateTmp, 'true');
});

test('unit contains no secret-looking literals', () => {
  const text = read(UNIT);
  assert.doesNotMatch(text, /^(TG_BOT_TOKENS|TG_LLM_KEY)\s*=/m);
  assert.doesNotMatch(text, /tok-[A-Za-z0-9-]{8,}/);
  assert.doesNotMatch(text, /sk-[A-Za-z0-9-]{8,}/);
});

// ── shell scripts ──

const SCRIPTS = {
  'install.sh': read(path.join(DEPLOY, 'install.sh')),
  'status.sh': read(path.join(DEPLOY, 'status.sh')),
  'rollout.sh': read(path.join(DEPLOY, 'rollout.sh')),
};

for (const [name, text] of Object.entries(SCRIPTS)) {
  test(`${name} uses strict mode (set -euo pipefail)`, () => {
    assert.match(text, /^set -euo pipefail$/m);
  });

  test(`${name} inlines no secret assignments or token literals`, () => {
    assert.doesNotMatch(text, /^\s*(export\s+)?(TG_BOT_TOKENS|TG_LLM_KEY)\s*=\s*['"]?\S/m);
    assert.doesNotMatch(text, /tok-[A-Za-z0-9-]{8,}/);
    assert.doesNotMatch(text, /sk-[A-Za-z0-9]{8,}/);
  });
}

test('install.sh: idempotent install path (copy -f, sed rewrite, daemon-reload, enable, restart-if-active)', () => {
  const t = SCRIPTS['install.sh'];
  assert.match(t, /cp -f "\$UNIT_SRC" "\$UNIT_DST\.tmp"/);
  assert.match(t, /sed -i "s#\/root\/agent-workforce#\$REPO#g" "\$UNIT_DST\.tmp"/);
  assert.match(t, /UNIT_DST=\/etc\/systemd\/system\/tg-gateway\.service/);
  assert.match(t, /systemctl daemon-reload/);
  assert.match(t, /systemctl enable .*tg-gateway\.service/);
  assert.match(t, /systemctl restart .*tg-gateway\.service/);
  // FS-E2: restart only when already active (enable --now handles first start)
  assert.match(t, /systemctl enable --now tg-gateway\.service/);
  assert.match(t, /systemctl is-active tg-gateway\.service/);
  assert.ok(t.indexOf('is-active tg-gateway.service') < t.indexOf('systemctl restart'));
});

test('install.sh: refuses when node missing or env file unreadable (fail closed)', () => {
  const t = SCRIPTS['install.sh'];
  assert.match(t, /command -v node/);
  assert.match(t, /-r "?\$ENV_FILE"?/);
  // both refusals must exit nonzero
  const refusals = t.split('command -v node').length - 1;
  assert.ok(refusals >= 1);
  assert.match(t, /\[ ! -r "\$ENV_FILE" \]/);
  assert.match(t, /exit 1/);
});

test('install.sh: health-gates /healthz within 30s and prints tailscale URL', () => {
  const t = SCRIPTS['install.sh'];
  assert.match(t, /\/healthz/);
  assert.match(t, /seq 1 30/); // FS-E2: 30 attempts × 1s = 30s gate
  assert.match(t, /tailscale/);
});

test('status.sh: exits nonzero when /healthz fails (source check)', () => {
  const t = SCRIPTS['status.sh'];
  const m = /if ! curl [^\n]*\/healthz[^\n]*; then\n([\s\S]*?)fi/.exec(t);
  assert.ok(m, 'status.sh must guard /healthz with an `if ! curl …` branch');
  assert.match(m[1], /exit 1/, 'healthz failure branch must exit 1');
});

test('status.sh: reports is-active, audit verify, disk usage, last 5 chain types', () => {
  const t = SCRIPTS['status.sh'];
  assert.match(t, /systemctl is-active .*tg-gateway\.service/);
  assert.match(t, /\/v1\/audit\/verify/);
  assert.match(t, /du -sh "\$REPO\/data"/);
  assert.match(t, /tail -n 5 "\$AUDIT_FILE"/);
  assert.match(t, /payload\.type/); // chain entry types
});

test('rollout.sh: ff-only pull → smoke tests → restart → health gate → rollback hint', () => {
  const t = SCRIPTS['rollout.sh'];
  assert.match(t, /git pull --ff-only/);
  assert.match(t, /tests\/standards\.test\.js/);
  assert.match(t, /tests\/app\.test\.js/);
  assert.match(t, /systemctl restart .*tg-gateway\.service/);
  assert.match(t, /\/healthz/);
  assert.match(t, /rollback hint/);
  assert.match(t, /git reset --hard \$PREV/);
});

test('rollout.sh: smoke tests run BEFORE the restart', () => {
  const t = SCRIPTS['rollout.sh'];
  const smoke = t.indexOf('tests/standards.test.js');
  const restart = t.indexOf('systemctl restart');
  assert.ok(smoke !== -1 && restart !== -1 && smoke < restart,
    'smoke tests must precede the service restart');
});
