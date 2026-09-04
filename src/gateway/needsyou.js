'use strict';
// Trust Gateway — NeedsYouItem v1 with types + NOW projection.
// Tenant-scoped, audit-sealed. Item types: 'clarification', 'credential', 'budget', 'approval'.

const fs = require('node:fs');
const path = require('node:path');

/** @typedef {'clarification'|'credential'|'budget'|'approval'} NeedsYouItemType */
/**
 * @typedef {Object} NeedsYouItem
 * @property {string} id
 * @property {string} tenantId
 * @property {NeedsYouItemType} type
 * @property {string} subject
 * @property {string|null} details
 * @property {string} status
 * @property {number} createdAt
 * @property {number|null} resolvedAt
 * @property {string|null} resolvedBy
 */

/**
 * Severity order: approval > budget > credential > clarification
 * @param {NeedsYouItemType} type
 * @returns {number} lower = more urgent
 */
function urgencyScore(type) {
  switch (type) {
    case 'approval': return 0;
    case 'budget': return 1;
    case 'credential': return 2;
    case 'clarification': return 3;
    default: return 99;
  }
}

class NeedsYouStore {
  /**
   * @param {Object} opts
   * @param {string|null} opts.file
   * @param {number} opts.now
   * @param {number} opts.maxItems
   */
  constructor({ file = null, now = () => Date.now(), maxItems = 200 } = {}) {
    this.file = file;
    this.now = now;
    this.maxItems = maxItems;
    this.items = new Map();
    this._next = 1;
    if (file && fs.existsSync(file)) this._load();
  }

  _load() {
    let arr;
    try {
      arr = JSON.parse(fs.readFileSync(this.file, 'utf8'));
    } catch {
      throw new Error('needyou: file unparseable — refusing to load (fail closed)');
    }
    if (!Array.isArray(arr)) throw new Error('needyou: file must be a JSON array');
    for (const item of arr) {
      if (!item || typeof item.id !== 'string') continue;
      this.items.set(item.id, item);
      const n = Number(item.id.replace(/^nys_/, ''));
      if (Number.isFinite(n) && n >= this._next) this._next = n + 1;
    }
    this._save();
  }

  _save() {
    if (!this.file) return;
    const rows = [...this.items.values()];
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = this.file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(rows) + '\n');
    fs.renameSync(tmp, this.file);
    try { fs.chmodSync(this.file, 0o600); } catch { }
  }

  create({ tenantId, type, subject, details = null }) {
    const id = `nys_${String(this._next++).padStart(6, '0')}`;
    const item = {
      id,
      tenantId,
      type,
      subject,
      details,
      status: 'open',
      createdAt: this.now(),
      resolvedAt: null,
      resolvedBy: null,
    };
    this.items.set(id, item);
    this._save();
    return item;
  }

  listByTenant(tenantId) {
    return [...this.items.values()].filter(
      (i) => i.tenantId === tenantId
    ).sort((a, b) => {
      if (a.status === 'open' && b.status !== 'open') return -1;
      if (a.status !== 'open' && b.status === 'open') return 1;
      return b.createdAt - a.createdAt;
    });
  }

  listOpen() {
    return [...this.items.values()].filter(
      (i) => i.status === 'open'
    ).sort((a, b) => {
      const urg = urgencyScore(a.type) - urgencyScore(b.type);
      if (urg !== 0) return urg;
      return b.createdAt - a.createdAt;
    });
  }

  resolve(id, resolvedBy) {
    const item = this.items.get(id);
    if (!item) return { ok: false, error: 'not_found' };
    if (item.status !== 'open') return { ok: false, error: `already_${item.status}` };
    item.status = 'resolved';
    item.resolvedAt = this.now();
    item.resolvedBy = resolvedBy;
    this._save();
    return { ok: true, item };
  }

  get(id) {
    return this.items.get(id) || null;
  }
}

module.exports = { NeedsYouStore, urgencyScore };
