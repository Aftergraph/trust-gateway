'use strict';
// Router v0.2 telemetry tests: outcome ledger, health scoring, fallback demotion.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { RouterTelemetry } = require('../src/gateway/router-telemetry.js');

function mk() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rt-'));
  return new RouterTelemetry({ file: path.join(dir, 'tele.json') });
}

test('record accumulates outcomes; health scores per provider', () => {
  const t = mk();
  t.record({ provider: 'good', model: 'm', ok: true });
  t.record({ provider: 'good', model: 'm', ok: true });
  t.record({ provider: 'bad', model: 'm', ok: false });
  const { scores } = t.health();
  assert.equal(scores.good.score, 1);
  assert.equal(scores['bad'].score, 0);
});

test('reorderFallbacks demotes failing providers below healthy ones', () => {
  const t = mk();
  for (let i = 0; i < 5; i++) t.record({ provider: 'flaky', model: 'm', ok: false });
  t.record({ provider: 'solid', model: 'm', ok: true });
  const out = t.reorderFallbacks([
    { model: 'a', provider: 'solid' },
    { model: 'm', provider: 'flaky' },
  ]);
  assert.equal(out[0].provider, 'solid', 'healthy provider first');
});

test('blacklist: providers with score 0 over >=3 samples', () => {
  const t = mk();
  for (let i = 0; i < 4; i++) t.record({ provider: 'dead', model: 'm', ok: false });
  t.record({ provider: 'ok-prov', model: 'm', ok: true });
  assert.deepEqual(t.blacklisted(), ['dead']);
});

test('persistence across instances', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rtp-'));
  const file = path.join(dir, 'tele.json');
  const t1 = new RouterTelemetry({ file });
  t1.record({ provider: 'p', model: 'm', ok: true });
  const t2 = new RouterTelemetry({ file });
  const { scores } = t2.health();
  assert.equal(scores.p.ok, 1, 'outcomes survive restart');
});

test('corrupt file refuses to load (fail closed)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rtc-'));
  fs.writeFileSync(path.join(dir, 'tele.json'), '{{{corrupt');
  assert.throws(() => new RouterTelemetry({ file: path.join(dir, 'tele.json') }), /refusing to load/);
});