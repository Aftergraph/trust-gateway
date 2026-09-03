'use strict';
// FS-H1 — self-hosting documentation tests.
//
// Covers: every env var name bin/gateway.js reads appears in
// docs/SELF-HOSTING.md (extracted by regex from the source, not a hardcoded
// list); every deploy script the guide references exists; RUNBOOK.md
// cross-links resolve; no real-looking tokens/secrets in the docs (fixture
// placeholders like fw-tok / at-tok are fine).

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const DOC = fs.readFileSync(path.join(ROOT, 'docs', 'SELF-HOSTING.md'), 'utf8');
const RUNBOOK = fs.readFileSync(path.join(ROOT, 'docs', 'RUNBOOK.md'), 'utf8');

// ── 1. env vars from bin/gateway.js are documented ──────────────────────────
test('SELF-HOSTING.md documents every env var bin/gateway.js reads', () => {
  const src = fs.readFileSync(path.join(ROOT, 'bin', 'gateway.js'), 'utf8');
  const envNames = new Set();
  for (const m of src.matchAll(/process\.env\.([A-Z][A-Z0-9_]*)/g)) {
    envNames.add(m[1]);
  }
  assert.ok(envNames.size >= 8, `expected >=8 env vars in gateway.js, found ${envNames.size}: ${[...envNames].join(', ')}`);
  for (const name of envNames) {
    assert.ok(
      DOC.includes(name),
      `docs/SELF-HOSTING.md does not mention ${name} (read by bin/gateway.js)`
    );
  }
});

test('SELF-HOSTING.md documents the TG_-prefixed ops vars', () => {
  for (const name of [
    'TG_BOT_TOKENS', 'TG_BOT_CAPS', 'TG_BOT_ROLES', 'TG_PORT',
    'TG_LLM_BASE_URL', 'TG_LLM_KEY', 'TG_LLM_MODEL',
    'TG_ALERT_URLS', 'TG_ALERT_TOKEN', 'TG_DISK_MAX_PCT', 'TG_DATA_DIR',
  ]) {
    assert.ok(DOC.includes(name), `docs/SELF-HOSTING.md does not mention ${name}`);
  }
});

// ── 2. every referenced deploy script exists ────────────────────────────────
test('every deploy/ script referenced in SELF-HOSTING.md exists', () => {
  const refs = new Set();
  for (const m of DOC.matchAll(/deploy\/([A-Za-z0-9._/-]+?)(?=[)\s`,:]|$)/gm)) {
    refs.add(`deploy/${m[1]}`);
  }
  assert.ok(refs.size >= 4, `expected >=4 deploy/ refs, found: ${[...refs].join(', ')}`);
  for (const ref of refs) {
    assert.ok(fs.existsSync(path.join(ROOT, ref)), `referenced file missing: ${ref}`);
  }
});

test('SELF-HOSTING.md references the backup timer units that ship', () => {
  for (const unit of ['tg-backup.service', 'tg-backup.timer']) {
    assert.ok(DOC.includes(unit), `doc missing backup unit ${unit}`);
    assert.ok(
      fs.existsSync(path.join(ROOT, 'deploy', 'backup-timer', unit)),
      `deploy/backup-timer/${unit} missing`
    );
  }
});

// ── 3. RUNBOOK cross-links are valid ────────────────────────────────────────
test('SELF-HOSTING.md RUNBOOK cross-links resolve to real sections', () => {
  const links = [...DOC.matchAll(/\[([^\]]*)\]\(RUNBOOK\.md(#[^)]*)?\)/g)];
  assert.ok(links.length >= 4, `expected >=4 RUNBOOK links, found ${links.length}`);
  for (const [, , anchor] of links) {
    if (!anchor) continue;
    // GitHub-style anchor: lowercase, spaces -> hyphens, punctuation dropped.
    const want = anchor.slice(1).toLowerCase().replace(/[^\w-]/g, '');
    const heads = [...RUNBOOK.matchAll(/^#{1,6}\s+(.+)$/gm)].map((m) => m[1]);
    const ok = heads.some((h) => h.toLowerCase().replace(/[^\w-]/g, '').includes(want) || want.includes(h.toLowerCase().replace(/[^\w-]/g, '')));
    assert.ok(ok || heads.some((h) => h.toLowerCase().replace(/[^\w-]/g, '') === want),
      `RUNBOOK.md has no heading matching anchor ${anchor}`);
  }
});

test('RUNBOOK.md failure-mode headings the doc promises all exist', () => {
  for (const h of ['Failure mode 1', 'Failure mode 2', 'Failure mode 3', 'Failure mode 4']) {
    assert.ok(RUNBOOK.includes(h), `RUNBOOK.md missing section ${h}`);
    assert.ok(DOC.includes(h), `SELF-HOSTING.md should reference ${h}`);
  }
});

// ── 4. no real secrets in the customer docs ─────────────────────────────────
// Fixture placeholders (fw-tok, at-tok, your-*-token) are fine. What must
// NEVER appear: a live-looking token value, an sk- key, or an assignment of a
// concrete secret to TG_BOT_TOKENS / TG_LLM_KEY (same gate as
// tests/ops-files.test.js).
const FORBIDDEN = [
  /sk-[A-Za-z0-9]{8,}/,                    // OpenAI-style key
  /(?:tok|op-tok)-[A-Za-z0-9]{6,}/,        // rendered live-token pattern
  /tok-[A-Za-z0-9]+-LIVE-[A-Za-z0-9]+/,    // deploy.test.js FAKE_ENV shape
  /^\s*(?:export\s+)?TG_BOT_TOKENS\s*=\s*['"]?[^\s'"\n]*tok-/m,
];

test('SELF-HOSTING.md contains no real-looking tokens or secrets', () => {
  for (const re of FORBIDDEN) {
    assert.ok(!re.test(DOC), `docs/SELF-HOSTING.md matches forbidden secret pattern: ${re}`);
  }
  // concrete secret assignments are forbidden; placeholder assignments are not
  assert.doesNotMatch(DOC, /^\s*TG_LLM_KEY\s*=\s*['"]?[^\s*'\n]/m);
});

test('site/docs.html self-hosting section carries no secrets and links the doc', () => {
  const site = fs.readFileSync(path.join(ROOT, 'site', 'docs.html'), 'utf8');
  assert.ok(site.includes('id="self-hosting"'), 'site/docs.html missing #self-hosting section');
  assert.ok(site.includes('docs/SELF-HOSTING.md'), 'site/docs.html does not reference docs/SELF-HOSTING.md');
  for (const re of FORBIDDEN) {
    assert.ok(!re.test(site), `site/docs.html matches forbidden secret pattern: ${re}`);
  }
  assert.ok(!/<img\s/i.test(site), 'unexpected image in self-hosting section');
});

// ── 5. doc mentions the hard requirements from the spec ─────────────────────
test('SELF-HOSTING.md covers prerequisites, ops, upgrade, uninstall', () => {
  for (const needle of [
    '## Prerequisites', '## Quickstart', '## Configuration', '## Daily operations',
    '## Failure modes', '## Upgrading', '## Uninstall',
    'deploy/install.sh', 'deploy/status.sh', 'deploy/watchdog.sh',
    'deploy/restore-drill.sh', 'TG_ALERT_URLS', 'WARNING',
    'systemctl disable --now tg-gateway',
  ]) {
    assert.ok(DOC.includes(needle), `SELF-HOSTING.md missing: ${needle}`);
  }
});
