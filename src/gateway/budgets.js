'use strict';
const fs = require('node:fs');

const validAmount = value => typeof value === 'number' &&
  Number.isFinite(value) && value >= 0 && value <= Number.MAX_SAFE_INTEGER;
const validActionId = value => typeof value === 'string' &&
  value.length > 0 && value.length <= 256;
const withinBudget = (spent, reserved, ceiling) =>
  validAmount(spent) && validAmount(reserved) && validAmount(ceiling) &&
  Number.isFinite(spent + reserved) && spent + reserved <= ceiling + 1e-9;

class BudgetLedger {
  /**
   * Frozen-semantic budget ledger with reservation semantics.
   * Tracks budgetUsd, spentUsd, reservedUsd with reserve()/settle()/commit()/refund().
   * Monotonic spending; replay-safe via actionId idempotency.
   */
  constructor({ budgetUsd, file, now }) {
    if (!validAmount(budgetUsd ?? 0)) throw new Error('budgetLedger: invalid budget ceiling');
    this.budgetUsd = budgetUsd ?? 0;
    this.spentUsd = 0;
    this.reservedUsd = 0;
    this.committed = new Map(); // actionId -> final cost (settled/committed)
    this.reservations = new Map(); // actionId -> reserved cost (HC4: reservation registry)
    this.settled = new Set(); // actionIds already settled (settle idempotency)
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
    if (!data || typeof data !== 'object' ||
        !validAmount(data.budgetUsd) || !validAmount(data.spentUsd) ||
        !validAmount(data.reservedUsd) ||
        !withinBudget(data.spentUsd, data.reservedUsd, data.budgetUsd) ||
        !data.committed || typeof data.committed !== 'object' || Array.isArray(data.committed) ||
        !data.reservations || typeof data.reservations !== 'object' || Array.isArray(data.reservations) ||
        !Array.isArray(data.settled) || !Array.isArray(data.actionHistory)) {
      throw new Error('budgetLedger: invalid persisted budget state');
    }
    const committed = Object.entries(data.committed);
    const reservations = Object.entries(data.reservations);
    if ([...committed, ...reservations].some(([id, cost]) =>
         !validActionId(id) || !validAmount(cost)) ||
        reservations.some(([id]) => committed.some(([other]) => id === other)) ||
        !data.settled.every(validActionId) ||
        data.settled.some(id => !Object.hasOwn(data.reservations, id))) {
      throw new Error('budgetLedger: corrupt reservation entries');
    }
    const reservationTotal = reservations.reduce((sum, [, cost]) => sum + cost, 0);
    if (!Number.isFinite(reservationTotal) ||
        Math.abs(reservationTotal - data.reservedUsd) > 1e-8) {
      throw new Error('budgetLedger: reservation balance mismatch');
    }
    this.budgetUsd = data.budgetUsd;
    this.spentUsd = data.spentUsd;
    this.reservedUsd = data.reservedUsd;
    this.committed = new Map(committed);
    this.reservations = new Map(reservations);
    this.settled = new Set(data.settled);
    this.actionHistory = data.actionHistory;
  }

  _save() {
    if (!this.file) return;
    const tmp = this.file + '.tmp';
    const fd = fs.openSync(tmp, 'w', 0o600);
    try {
      fs.writeFileSync(fd, JSON.stringify({
        budgetUsd: this.budgetUsd,
        spentUsd: this.spentUsd,
        reservedUsd: this.reservedUsd,
        committed: Object.fromEntries(this.committed),
        reservations: Object.fromEntries(this.reservations),
        settled: [...this.settled],
        actionHistory: this.actionHistory,
      }));
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(tmp, this.file);
  }

  /** Reserve budget for action; returns true if successful. */
  reserve(actionId, cost) {
    if (!validActionId(actionId) || !validAmount(cost) ||
        !withinBudget(this.spentUsd, this.reservedUsd, this.budgetUsd)) return false;
    if (this.committed.has(actionId) || (this.reservations && this.reservations.has(actionId))) {
      return false; // idempotent: already reserved or committed
    }
    if (!withinBudget(this.spentUsd, this.reservedUsd + cost, this.budgetUsd)) {
      return false; // budget exceeded or arithmetic invalid
    }
    this.reservedUsd += cost;
    this.reservations.set(actionId, cost);
    this.actionHistory.push({ actionId, cost, type: 'reserve', ts: new Date(this.now()).toISOString() });
    this._save();
    return true;
  }

  /** Commit reserved budget to spent; returns true if successful. */
  commit(actionId) {
    if (!validActionId(actionId) || !this.reservations.has(actionId) ||
        !withinBudget(this.spentUsd, this.reservedUsd, this.budgetUsd)) {
      return false; // idempotent: never reserved
    }
    const cost = this.reservations.get(actionId);
    this.reservations.delete(actionId);
    this.committed.set(actionId, cost);
    this.reservedUsd -= cost;
    this.spentUsd += cost;
    this.actionHistory.push({ actionId, cost, type: 'commit', ts: new Date(this.now()).toISOString() });
    this._save();
    return true;
  }

  /** Settle final cost after execution; returns true if successful. */
  settle(actionId, cost) {
    if (!validActionId(actionId) || !validAmount(cost) ||
        !this.reservations.has(actionId) || this.settled.has(actionId) ||
        !withinBudget(this.spentUsd, this.reservedUsd, this.budgetUsd)) {
      return false; // idempotent: settle once after reserve
    }
    const reserved = this.reservations.get(actionId);
    if (!validAmount(reserved) ||
        !withinBudget(this.spentUsd, this.reservedUsd + (cost - reserved), this.budgetUsd))
      return false; // never settle past the ceiling, or alter state on denial
    this.reservations.set(actionId, cost);
    this.reservedUsd += (cost - reserved); // adjust to final cost (may be negative = refund)
    this.settled.add(actionId);
    this.actionHistory.push({ actionId, cost, type: 'settle', ts: new Date(this.now()).toISOString() });
    this._save();
    return true;
  }

  /** Refund budget if action failed; returns true if successful. */
  refund(actionId) {
    if (!validActionId(actionId) || !this.reservations.has(actionId)) {
      return false; // idempotent: never reserved
    }
    const cost = this.reservations.get(actionId);
    this.reservations.delete(actionId);
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
