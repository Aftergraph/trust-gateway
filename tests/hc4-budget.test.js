const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const { BudgetLedger } = require('../src/gateway/budgets.js');

describe('HC4: Budget Conservation', () => {
  let tempFile;

  beforeEach(() => {
    tempFile = fs.mkdtempSync(path.join(os.tmpdir(), 'budget-test-'));
  });

  afterEach(() => {
    if (fs.existsSync(tempFile)) fs.unlinkSync(tempFile);
  });

  it('HC4-02: Ledger reserve/settle/commit/refund semantics', () => {
    const ledger = new BudgetLedger({ budgetUsd: 50, file: tempFile });
    const now = Date.now();

    // Reserve succeeds
    expect(ledger.reserve('act-001', 15)).toBe(true);
    expect(ledger.reservedUsd).toBe(15);
    expect(ledger.spentUsd).toBe(0);

    // Idempotent reserve
    expect(ledger.reserve('act-001', 10)).toBe(false);
    expect(ledger.reservedUsd).toBe(15);

    // Settle adds to committed
    expect(ledger.settle('act-001', 15)).toBe(true);

    // Commit moves from reserved to spent
    expect(ledger.commit('act-001')).toBe(true);
    expect(ledger.spentUsd).toBe(15);
    expect(ledger.reservedUsd).toBe(0);
  });

  it('HC4-02: Budget exhausted blocks new reservations', () => {
    const ledger = new BudgetLedger({ budgetUsd: 20, file: tempFile });
    
    expect(ledger.reserve('act-a', 15)).toBe(true);
    expect(ledger.reserve('act-b', 10)).toBe(false); // Would exceed
    expect(ledger.available).toBe(5);
  });

  it('HC4-02: Refund returns reserved budget', () => {
    const ledger = new BudgetLedger({ budgetUsd: 50, file: tempFile });
    
    expect(ledger.reserve('act-fail', 20)).toBe(true);
    expect(ledger.reservedUsd).toBe(20);

    expect(ledger.refund('act-fail')).toBe(true);
    expect(ledger.reservedUsd).toBe(0);

    // Idempotent refund
    expect(ledger.refund('act-fail')).toBe(false);
  });

  it('HC4-02: Parallel execution budget accounting', () => {
    const ledger = new BudgetLedger({ budgetUsd: 20, file: tempFile });

    // agent-a reserves 15.0
    expect(ledger.reserve('act-a', 15)).toBe(true);
    expect(ledger.reservedUsd).toBe(15);

    // agent-b should be budget-limited (total would be 25 > 20)
    expect(ledger.reserve('act-b', 10)).toBe(false);
    expect(ledger.available).toBe(5);
  });

  it('HC4-01: Delegation chain budget enforcement', () => {
    const ledger = new BudgetLedger({ budgetUsd: 50, file: tempFile });
    
    // Root has 50, children should not aggregate to > 50
    const reserveBudget = (budget) => {
      const now = Date.now();
      const actionId = `del-${now}`;
      return ledger.reserve(actionId, budget);
    };

    // Two child delegations of 30 each = 60 > 50
    expect(reserveBudget(30)).toBe(true);
    expect(reserveBudget(30)).toBe(false); // Exceeds root
  });

  it('HC4-02: Idempotent operations', () => {
    const ledger = new BudgetLedger({ budgetUsd: 50, file: tempFile });

    // Reserve once
    expect(ledger.reserve('idemp-test', 10)).toBe(true);
    expect(ledger.reserve('idemp-test', 10)).toBe(false); // Idempotent
    expect(ledger.reservedUsd).toBe(10);

    // Settle once
    expect(ledger.settle('idemp-test', 10)).toBe(true);
    expect(ledger.settle('idemp-test', 10)).toBe(false); // Idempotent

    // Commit once
    expect(ledger.commit('idemp-test')).toBe(true);
    expect(ledger.commit('idemp-test')).toBe(false); // Idempotent
    expect(ledger.spentUsd).toBe(10);
  });

  it('HC4-02: Persisted ledger state', () => {
    // Create ledger and reserve
    const ledger1 = new BudgetLedger({ budgetUsd: 50, file: tempFile });
    expect(ledger1.reserve('persist-test', 25)).toBe(true);
    expect(ledger1.reservedUsd).toBe(25);

    // Create new instance from same file
    const ledger2 = new BudgetLedger({ budgetUsd: 50, file: tempFile });
    expect(ledger2.reservedUsd).toBe(25);
    expect(ledger2.reserve('persist-test', 25)).toBe(false); // Idempotent across instances
  });
});
