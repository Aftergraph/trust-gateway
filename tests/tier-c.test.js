'use strict';
// FS-F5 — tier-C source-level gate: the chaos battery and runbook must
// exist, cover all four failure modes, and carry no secrets.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const chaos = fs.readFileSync(path.join(ROOT, 'tests/conformance/tier-c/chaos.test.js'), 'utf8');
const runbook = fs.readFileSync(path.join(ROOT, 'docs/RUNBOOK.md'), 'utf8');
const script = fs.readFileSync(path.join(ROOT, 'scripts/conformance-tier-c.sh'), 'utf8');

test('tier-C: chaos battery exists with all four scenarios', () => {
  assert.match(chaos, /kill -9 mid-flight/);
  assert.match(chaos, /concurrent writers on ONE sqlite file/);
  assert.match(chaos, /ENOSPC/);
  assert.match(chaos, /restart storm/);
  // real spawned gateways, not mocks
  assert.match(chaos, /spawn\('node'/);
  assert.match(chaos, /SIGKILL/);
  // honest observation, not faked PASS
  assert.match(chaos, /OBSERVED/);
});

test('tier-C: runner script exists and runs the chaos battery', () => {
  assert.match(script, /conformance\/tier-c\/chaos\.test\.js/);
  assert.match(script, /TIER-C/);
});

test('tier-C: runbook covers the four failure modes with real commands', () => {
  const rb = fs.readFileSync(path.join(ROOT, 'docs', 'RUNBOOK.md'), 'utf8');
  assert.match(rb, /chain verify fails/);
  assert.match(rb, /disk full/);
  assert.match(rb, /crash-loops/);
  assert.match(rb, /restore needed/);
  assert.match(rb, /systemctl stop tg-gateway/);
  assert.match(rb, /journalctl -u tg-gateway/);
  assert.match(rb, /v2\/backup\/restore/);
  assert.match(rb, /deploy\/restore-drill\.sh/);
});

test('tier-C: no hardcoded secrets in script + runbook (tokens only in the battery fixtures)', () => {
  for (const f of ['scripts/conformance-tier-c.sh', 'docs/RUNBOOK.md']) {
    const src = fs.readFileSync(path.join(ROOT, f), 'utf8');
    assert.ok(!/sk-[a-zA-Z0-9]{8,}/.test(src), `${f}: API-key pattern`);
    assert.ok(!/dgr_live/.test(src), `${f}: live LLM key`);
    assert.ok(!/fw-tok|at-tok/.test(src), `${f}: bot tokens must not leak into ops artifacts`);
  }
});