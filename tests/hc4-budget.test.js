'use strict';
// HC4 budget conservation tests (node:test port of the jest-drafted suite).
// Frozen semantics: reserve()/settle()/commit()/refund() with actionId idempotency,
// monotonic spend, ceiling enforcement. File-based persistence tested across instances.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const { BudgetLedger } = require('../src/gateway/budgets.js');

function mkLedger(budgetUsd) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hc4-'));
  const file = path.join(dir, 'ledger.json');
  const ledger = new BudgetLedger({ budgetUsd, file });
  return { ledger, dir, file };
}

function cleanup({ dir }) {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort */ }
}

test('HC4-02: reserve/settle/commit/refund semantics', () => {
  const h = mkLedger(50);
  try {
    assert.equal(h.ledger.reserve('act-001', 15), true);
    assert.equal(h.ledger.reservedUsd, 15);
    assert.equal(h.ledger.spentUsd, 0);

    // Idempotent reserve: same actionId cannot double-reserve
    assert.equal(h.ledger.reserve('act-001', 10), false);
    assert.equal(h.ledger.reservedUsd, 15);

    assert.equal(h.ledger.commit('act-001'), true);
    assert.equal(h.ledger.spentUsd, 15);
    assert.equal(h.ledger.reservedUsd, 0);
  } finally { cleanup(h); }
});

test('HC4-02: budget exhausted blocks new reservations', () => {
  const h = mkLedger(20);
  try {
    assert.equal(h.ledger.reserve('act-a', 15), true);
    assert.equal(h.ledger.reserve('act-b', 10), false, 'would exceed ceiling');
    assert.equal(h.ledger.reservedUsd, 15);
  } finally { cleanup(h); }
});

test('HC4-02: refund returns reserved budget', () => {
  const h = mkLedger(50);
  try {
    assert.equal(h.ledger.reserve('act-fail', 20), true);
    assert.equal(h.ledger.reservedUsd, 20);
    assert.equal(h.ledger.refund('act-fail'), true);
    assert.equal(h.ledger.reservedUsd, 0);
    assert.equal(h.ledger.refund('act-fail'), false, 'idempotent');
  } finally { cleanup(h); }
});

test('HC4-02: parallel execution budget accounting', () => {
  const h = mkLedger(20);
  try {
    assert.equal(h.ledger.reserve('act-a', 15), true);
    assert.equal(h.ledger.reserve('act-b', 10), false);
    assert.equal(h.ledger.reservedUsd, 15);
  } finally { cleanup(h); }
});

test('HC4-01: delegation chain budget enforcement', () => {
  const h = mkLedger(50);
  try {
    let n = 0;
    const reserveBudget = (budget) => h.ledger.reserve(`del-${Date.now()}-${n++}`, budget);
    assert.equal(reserveBudget(30), true);
    assert.equal(reserveBudget(30), false, 'two children of 30 exceed root 50');
  } finally { cleanup(h); }
});

test('HC4-02: idempotent operations', () => {
  const h = mkLedger(50);
  try {
    assert.equal(h.ledger.reserve('idemp-test', 10), true);
    assert.equal(h.ledger.reserve('idemp-test', 10), false);
    assert.equal(h.ledger.reservedUsd, 10);

    assert.equal(h.ledger.settle('idemp-test', 10), true);
    assert.equal(h.ledger.settle('idemp-test', 10), false);

    assert.equal(h.ledger.commit('idemp-test'), true);
    assert.equal(h.ledger.commit('idemp-test'), false);
    assert.equal(h.ledger.spentUsd, 10);
  } finally { cleanup(h); }
});

test('HC4-02: persisted ledger state across instances', () => {
  const h = mkLedger(50);
  try {
    assert.equal(h.ledger.reserve('persist-test', 25), true);
    assert.equal(h.ledger.reservedUsd, 25);

    const ledger2 = new BudgetLedger({ budgetUsd: 50, file: h.file });
    assert.equal(ledger2.reservedUsd, 25);
    assert.equal(ledger2.reserve('persist-test', 25), false, 'idempotent across instances');
  } finally { cleanup(h); }
});
test('HC4 security: reject negative, non-finite, and malformed reservations', () => {
  const h = mkLedger(20);
  try {
    for (const amount of [-5, NaN, Infinity, -Infinity, '5', null, undefined]) {
      assert.equal(h.ledger.reserve('unsafe-' + String(amount), amount), false);
    }
    assert.equal(h.ledger.reserve('', 1), false);
    assert.equal(h.ledger.reserve('legit', 15), true);
    assert.equal(h.ledger.reservedUsd, 15);
    assert.equal(h.ledger.reserve('overspend', 5.01), false);
    assert.equal(h.ledger.available, 5);
  } finally { cleanup(h); }
});

test('HC4 security: settlement cannot exceed ceiling or corrupt existing reserve', () => {
  const h = mkLedger(20);
  try {
    assert.equal(h.ledger.reserve('one', 12), true);
    assert.equal(h.ledger.reserve('two', 5), true);
    const before = JSON.stringify(h.ledger.summary);
    for (const cost of [17, -2, NaN, Infinity, '9']) {
      assert.equal(h.ledger.settle('one', cost), false);
      assert.equal(JSON.stringify(h.ledger.summary), before);
    }
    assert.equal(h.ledger.settle('one', 14), true);
    assert.equal(h.ledger.reservedUsd, 19);
    assert.equal(h.ledger.commit('one'), true);
    assert.equal(h.ledger.spentUsd, 14);
    assert.equal(h.ledger.reserve('three', 2), false);
  } finally { cleanup(h); }
});

test('HC4 security: invalid and impossible persisted budget state fails closed', () => {
  const h = mkLedger(30);
  try {
    assert.equal(h.ledger.reserve('x', 10), true);
    const state = JSON.parse(fs.readFileSync(h.file, 'utf8'));
    for (const corrupted of [
      { ...state, reservedUsd: -10 },
      { ...state, reservedUsd: 100 },
      { ...state, reservations: { x: -10 } },
      { ...state, settled: ['missing'] },
    ]) {
      fs.writeFileSync(h.file, JSON.stringify(corrupted));
      assert.throws(() => new BudgetLedger({ budgetUsd: 30, file: h.file }),
        /budgetLedger: (invalid|corrupt|reservation)/);
    }
  } finally { cleanup(h); }
});
