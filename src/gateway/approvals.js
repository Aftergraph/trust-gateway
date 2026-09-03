'use strict';
// Trust Gateway — human approvals with TTL. Fail closed on expiry.
// Optional durability: `file` (JSON, atomic write, 0600). Pending approvals
// survive restart; resolved approvals keep metadata but NEVER their args
// (secrets scrubbed on resolve and before every save).

const fs = require('node:fs');
const path = require('node:path');
const { computeImpact } = require('./impact');

const DEFAULT_TTL_MS = 15 * 60 * 1000;

class ApprovalStore {
  constructor({ ttlMs = DEFAULT_TTL_MS, now = () => Date.now(), file = null, gw = null, computeImpactFn = computeImpact } = {}) {
    this.ttlMs = ttlMs;
    this.now = now;
    this.file = file;
    this.gw = gw;
    this._computeImpact = computeImpactFn;
    this.requests = new Map(); // id -> request
    this._next = 1;
    if (file && fs.existsSync(file)) this._load();
  }

  _load() {
    let arr;
    try {
      arr = JSON.parse(fs.readFileSync(this.file, 'utf8'));
    } catch {
      throw new Error('approvals: file unparseable — refusing to load (fail closed)');
    }
    if (!Array.isArray(arr)) throw new Error('approvals: file must be a JSON array');
    for (const r of arr) {
      if (!r || typeof r.id !== 'string') throw new Error('approvals: entry missing id');
      this.requests.set(r.id, r);
      const n = Number(r.id.replace(/^apr_/, ''));
      if (Number.isFinite(n) && n >= this._next) this._next = n + 1;
    }
    this.sweep(); // expired pending entries fail closed on load
  }

  _save() {
    if (!this.file) return;
    const rows = [...this.requests.values()].map((r) => ({
      ...r,
      args: r.status === 'pending' ? r.args : undefined, // scrub secrets from resolved
      argsSummary: r.status === 'pending' ? r.argsSummary : undefined,
    }));
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = this.file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(rows) + '\n');
    fs.renameSync(tmp, this.file);
    try { fs.chmodSync(this.file, 0o600); } catch { /* best effort */ }
  }

  request({ bot, tool, args, reason, ttlMs = null } = {}) {
    const id = `apr_${String(this._next++).padStart(6, '0')}`;
    const created = this.now();
    const impact = this._computeImpact({ tool, args, gw: this.gw });
    const req = {
      id,
      bot: bot ? bot.name : null,
      tool,
      args,
      argsSummary: args === undefined ? null : JSON.stringify(args).slice(0, 200),
      reason: reason || null,
      status: 'pending',
      createdAt: created,
      expiresAt: created + (ttlMs ?? this.ttlMs),
      resolvedBy: null,
      resolvedAt: null,
      impact,
    };
    this.requests.set(id, req);
    this._save();
    return req;
  }

  _expired(req) {
    return req.status === 'pending' && this.now() > req.expiresAt;
  }

  resolve(id, verdict, approver) {
    const req = this.requests.get(id);
    if (!req) return { ok: false, error: 'not_found' };
    if (req.status !== 'pending') return { ok: false, error: `already_${req.status}` };
    if (this._expired(req)) {
      req.status = 'expired';
      req.args = null;
      this._save();
      return { ok: false, error: 'expired' }; // fail closed
    }
    if (!approver || typeof approver !== 'string' || approver.length === 0)
      return { ok: false, error: 'approver_required' };
    if (verdict !== 'approve' && verdict !== 'deny') return { ok: false, error: 'bad_verdict' };
    req.status = verdict === 'approve' ? 'approved' : 'denied';
    req.resolvedBy = approver;
    req.resolvedAt = this.now();
    req.args = null; // scrub secrets from memory...
    req.argsSummary = null; // ...and from summary too
    this._save();
    return { ok: true, request: req };
  }

  get(id) {
    const req = this.requests.get(id);
    if (!req) return null;
    if (this._expired(req)) req.status = 'expired';
    return req;
  }

  listPending() {
    this.sweep();
    return [...this.requests.values()].filter((r) => r.status === 'pending');
  }

  sweep() {
    for (const req of this.requests.values()) {
      if (this._expired(req)) req.status = 'expired';
    }
  }
}

module.exports = { ApprovalStore, DEFAULT_TTL_MS };