'use strict';
const fs = require('node:fs');

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
    // Write atomically to temp file, then rename
    const tmpFile = this.file + '.tmp';
    fs.writeFileSync(tmpFile, JSON.stringify({
      limits: Object.fromEntries(this.limits),
      usage: Object.fromEntries(this.usage),
    }));
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
      // No budget limit for this bot - unlimited
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

module.exports = { BudgetStore };
