'use strict';
// P2 — Golden-set eval gate (v1).
//
// Golden sets are fail-closed governance contracts run against REAL store objects
// (BudgetLedger, HashChain, canApprove) — the same classes the live mounts use.
// Gate passes only at 100%; regressions are recorded in an append-only run ledger
// (tmp+rename 0600, refuse-corrupt). GET /v2/evals/latest lets CI gate on it.
//
// Sets (pinned by STUDY-008-v2 + STUDY-013 hard cases):
//   budget-exhaustion  — BudgetLedger ceiling + idempotent replay (HC4)
//   approval-rbac      — worker denied, operator allowed (canApprove law)
//   evidence-integrity — HashChain tamper -> verify().ok false

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
// EVAL_ENTRY is a hash-chain payload type inside the eval's own test chain —
// NOT a TG audit event type; kept as a constant so the TRANSPARENCY extractor
// doesn't false-positive.
const EVAL_ENTRY = 'eval_entry';
const crypto = require('node:crypto');

function sha16(obj) {
  return crypto.createHash('sha256').update(JSON.stringify(obj)).digest('hex').slice(0, 16);
}

const GOLDEN_SETS = [
  {
    id: 'budget-exhaustion',
    description: 'BudgetLedger rejects reservations beyond the ceiling; idempotent replay',
    run() {
      const { BudgetLedger } = require('./budgets');
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'eval-budget-'));
      const results = [];
      try {
        const led = new BudgetLedger({ budgetUsd: 20, file: path.join(dir, 'b.json') });
        results.push({ id: 'budget/admit', pass: led.reserve('eval-b1', 15) === true });
        results.push({ id: 'budget/exhausted-blocks', pass: led.reserve('eval-b2', Number.MAX_SAFE_INTEGER) === false });
        results.push({ id: 'budget/replay-idempotent', pass: led.reserve('eval-b1', 5) === false });
      } finally {
        try { fs.rmSync(dir, { recursive: true, force: true }); } catch { }
      }
      return results;
    },
  },
  {
    id: 'approval-rbac',
    description: 'canApprove law: worker denied, operator allowed, wildcard allowed',
    run() {
      const { canApprove } = require('./rbac');
      return [
        { id: 'rbac/worker-denied', pass: canApprove({ role: 'worker', capabilities: ['fs.read'] }) === false },
        { id: 'rbac/operator-allowed', pass: canApprove({ role: 'operator' }) === true },
        { id: 'rbac/wildcard-allowed', pass: canApprove({ role: 'worker', capabilities: ['*'] }) === true },
        { id: 'rbac/null-denied', pass: canApprove(null) === false },
      ];
    },
  },
  {
    id: 'evidence-integrity',
    description: 'HashChain: tamper detected, verify().ok false; clean chain verify true',
    run() {
      const { HashChain } = require('./hash-chain');
      const chain = new HashChain();
      chain.append({ type: EVAL_ENTRY, data: 1 });
      chain.append({ type: EVAL_ENTRY, data: 2 });
      const clean = chain.verify().ok === true;
      // tamper the payload of entry 1 -> verify must fail
      chain.entries[0].payload.data = 999;
      const tampered = chain.verify().ok === false;
      return [
        { id: 'evidence/clean-verify', pass: clean === true },
        { id: 'evidence/tamper-detected', pass: tampered === true },
      ];
    },
  },
];

class EvalRunner {
  constructor({ file = null, now = () => new Date().toISOString() } = {}) {
    this.file = file;
    this.now = now;
    this.runs = [];
    this._load();
  }

  _load() {
    if (!this.file || !fs.existsSync(this.file)) return;
    let data;
    try {
      data = JSON.parse(fs.readFileSync(this.file, 'utf8'));
    } catch {
      throw new Error('evals: file unparseable — refusing to load (fail closed)');
    }
    if (!Array.isArray(data.runs)) throw new Error('evals: file must hold a runs array');
    this.runs = data.runs;
  }

  _save() {
    if (!this.file) return;
    const tmp = this.file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify({ runs: this.runs }), { mode: 0o600 });
    if (process.platform !== 'win32') { try { fs.chmodSync(tmp, 0o600); } catch { } }
    fs.renameSync(tmp, this.file);
  }

  /** Run all golden sets. Returns the run record; ledger keeps the last 50. */
  runAll() {
    const checks = [];
    for (const set of GOLDEN_SETS) {
      try {
        checks.push(...set.run().map((r) => ({ set: set.id, ...r })));
      } catch (e) {
        checks.push({ set: set.id, id: `${set.id}/runner-error`, pass: false, error: String(e.message).slice(0, 200) });
      }
    }
    const failed = checks.filter((c) => !c.pass);
    const run = {
      id: `eval_${crypto.randomBytes(6).toString('hex')}`,
      generated_at: this.now(),
      total: checks.length,
      failed: failed.length,
      gate: failed.length === 0 ? 'PASS' : 'FAIL',
      snapshot_hash: sha16(checks),
      checks,
    };
    this.runs.push(run);
    if (this.runs.length > 50) this.runs = this.runs.slice(-50);
    this._save();
    return run;
  }

  latest() { return this.runs[this.runs.length - 1] || null; }
}

module.exports = { EvalRunner, GOLDEN_SETS, sha16 };