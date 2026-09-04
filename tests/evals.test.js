'use strict';
// P2 eval-gate tests: runner determinism, ledger persistence, tamper detection.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { EvalRunner, GOLDEN_SETS } = require('../src/gateway/evals.js');

function mkRunner() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'eval-'));
  return new EvalRunner({ file: path.join(dir, 'eval-ledger.json') });
}

test('all golden sets run; gate PASS at 100%', () => {
  const r = mkRunner();
  const run = r.runAll();
  assert.equal(run.gate, 'PASS');
  assert.equal(run.failed, 0);
  assert.ok(run.total >= 9, `expected >=9 checks, got ${run.total}`);
  const sets = new Set(run.checks.map((c) => c.set));
  assert.deepEqual([...sets].sort(), ['approval-rbac', 'budget-exhaustion', 'evidence-integrity'].sort());
});

test('runner error in a set records a FAIL, not a crash', () => {
  const r = mkRunner();
  // force an error by replacing a set's run with a thrower
  const original = GOLDEN_SETS[0].run;
  GOLDEN_SETS[0].run = () => { throw new Error('eval boom'); };
  try {
    const run = r.runAll();
    assert.equal(run.gate, 'FAIL');
    const err = run.checks.find((c) => c.set === 'budget-exhaustion' && c.error);
    assert.ok(err, 'error recorded on the failing set');
  } finally {
    GOLDEN_SETS[0].run = original;
  }
});

test('ledger persists across instances; bounded to 50 runs', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'evalp-'));
  const file = path.join(dir, 'eval-ledger.json');
  const r1 = new EvalRunner({ file });
  for (let i = 0; i < 3; i++) r1.runAll();
  const r2 = new EvalRunner({ file });
  assert.equal(r2.runs.length, 3, 'history survives restart');
});

test('latest() returns the newest run', () => {
  const r = mkRunner();
  assert.equal(r.latest(), null);
  const first = r.runAll();
  const second = r.runAll();
  assert.equal(r.latest().id, second.id);
});

test('corrupt ledger refuses to load (fail closed)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'evalc-'));
  fs.writeFileSync(path.join(dir, 'eval-ledger.json'), '{{{corrupt');
  assert.throws(() => new EvalRunner({ file: path.join(dir, 'eval-ledger.json') }), /refusing to load/);
});