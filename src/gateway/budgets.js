'use strict';
const fs = require('node:fs');

class BudgetLedger {
  /**
   * Frozen-semantic budget ledger with reservation semantics.
   * Tracks budgetUsd, spentUsd, reservedUsd with reserve()/settle()/commit()/refund().
   * Monotonic spending; replay-safe via actionId idempotency.
   */
  constructor({ budgetUsd, file, now }) {
    this.budgetUsd = budgetUsd || 0;
    this.spentUsd = 0;
    this.reservedUsd = 0;
    this.committed = new Map(); // actionId -> cost
    this.actionHistory = []; // replay-safe audit trail
    this.file = file;
    this.now = now || (() => Date.now());
    this._load();
  }

  _load() {
    if (!this.file || !fs.existsSync(this.file)) return;
    let data;
    try {
      data = JSON.parse(fs.readFileSync(this.file, 'utf8'));
    } catch (err) {
      throw new Error('budgetLedger: refusing to load corrupt file (fail closed)');
    }
    this.budgetUsd = data.budgetUsd || 0;
    this.spentUsd = data.spentUsd || 0;
    this.reservedUsd = data.reservedUsd || 0;
    this.committed = new Map(Object.entries(data.committed || {}));
    this.actionHistory = data.actionHistory || [];
  }

  _save() {
    if (!this.file) return;
    const tmpFile = this.file + '.tmp';
    fs.writeFileSync(tmpFile, JSON.stringify({
      budgetUsd: this.budgetUsd,
      spentUsd: this.spentUsd,
      reservedUsd: this.reservedUsd,
      committed: Object.fromEntries(this.committed),
      actionHistory: this.actionHistory,
    }), { mode: 0o600 });
    if (process.platform !== 'win32') fs.chmodSync(tmpFile, 0o600);
    fs.renameSync(tmpFile, this.file);
  }

  /** Reserve budget for action; returns true if successful. */
  reserve(actionId, cost) {
    if (this.committed.has(actionId)) {
      return false; // idempotent: already committed
    }
    if (this.spentUsd + this.reservedUsd + cost > this.budgetUsd) {
      return false; // budget exceeded
    }
    this.reservedUsd += cost;
    this.actionHistory.push({ actionId, cost, type: 'reserve', ts: new Date(this.now()).toISOString() });
    this._save();
    return true;
  }

  /** Commit reserved budget to spent; returns true if successful. */
  commit(actionId) {
    if (!this.committed.has(actionId)) {
      return false; // idempotent: never reserved
    }
    const cost = this.committed.get(actionId);
    this.committed.delete(actionId);
    this.reservedUsd -= cost;
    this.spentUsd += cost;
    this.actionHistory.push({ actionId, cost, type: 'commit', ts: new Date(this.now()).toISOString() });
    this._save();
    return true;
  }

  /** Settle final cost after execution; returns true if successful. */
  settle(actionId, cost) {
    if (this.committed.has(actionId)) {
      return false; // idempotent: already settled
    }
    this.committed.set(actionId, cost);
    this.reservedUsd += cost;
    this.actionHistory.push({ actionId, cost, type: 'settle', ts: new Date(this.now()).toISOString() });
    this._save();
    return true;
  }

  /** Refund budget if action failed; returns true if successful. */
  refund(actionId) {
    if (!this.committed.has(actionId)) {
      return false; // idempotent: never reserved
    }
    const cost = this.committed.get(actionId);
    this.committed.delete(actionId);
    this.reservedUsd -= cost;
    this.actionHistory.push({ actionId, cost, type: 'refund', ts: new Date(this.now()).toISOString() });
    this._save();
    return true;
  }

  get available() {
    return Math.max(0, this.budgetUsd - this.spentUsd - this.reservedUsd);
  }

  get summary() {
    return {
      budgetUsd: this.budgetUsd,
      spentUsd: this.spentUsd,
      reservedUsd: this.reservedUsd,
      available: this.available,
    };
  }
}

class BudgetStore {
  constructor({ now, file } = {}) {
    this.now = now || (() => Date.now());
    this.file = file;
    this.limits = new Map(); // bot -> { maxActionsPerDay }
    this.usage = new Map(); // bot -> { usedToday, dayStart }
    this._load();
  }
  
  _load() {
    if (!this.file || !fs.existsSync(this.file)) return;
    let data;
    try {
      data = JSON.parse(fs.readFileSync(this.file, 'utf8'));
    } catch (err) {
      throw new Error('budgets: refusing to load corrupt file (fail closed)');
    }
    this.limits = new Map(Object.entries(data.limits || {}));
    this.usage = new Map(Object.entries(data.usage || {}));
  }
  
  _save() {
    if (!this.file) return;
    const tmpFile = this.file + '.tmp';
    fs.writeFileSync(tmpFile, JSON.stringify({
      limits: Object.fromEntries(this.limits),
      usage: Object.fromEntries(this.usage),
    }), { mode: 0o600 });
    if (process.platform !== 'win32') fs.chmodSync(tmpFile, 0o600);
    fs.renameSync(tmpFile, this.file);
  }
  
  setLimit(bot, limit) {
    this.limits.set(bot, limit);
    this._save();
  }
  
  getLimit(bot) {
    return this.limits.get(bot);
  }
  
  getUsage(bot) {
    return this.usage.get(bot) || { usedToday: 0, dayStart: null };
  }
  
  consume(bot) {
    const limit = this.limits.get(bot);
    if (!limit) {
      return { ok: true, unlimited: true };
    }
    
    const now = this.now();
    const dayStart = Math.floor(now / 86400000) * 86400000; // UTC day start
    const usage = this.usage.get(bot) || { usedToday: 0, dayStart: 0 };
    
    // Reset counter if new day
    if (usage.dayStart !== dayStart) {
      usage.usedToday = 0;
      usage.dayStart = dayStart;
    }
    
    if (usage.usedToday >= limit.maxActionsPerDay) {
      return { ok: false, reason: 'budget_exhausted' };
    }
    
    usage.usedToday++;
    this.usage.set(bot, usage);
    this._save();
    
    return { 
      ok: true, 
      remaining: limit.maxActionsPerDay - usage.usedToday 
    };
  }
}

module.exports = { BudgetLedger, BudgetStore };
