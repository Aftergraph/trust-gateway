'use strict';
// Trust Gateway — human approvals with TTL. Fail closed on expiry.

const DEFAULT_TTL_MS = 15 * 60 * 1000;

class ApprovalStore {
  constructor({ ttlMs = DEFAULT_TTL_MS, now = () => Date.now() } = {}) {
    this.ttlMs = ttlMs;
    this.now = now;
    this.requests = new Map(); // id -> request
    this._next = 1;
  }

  request({ bot, tool, args, reason, ttlMs = null } = {}) {
    const id = `apr_${String(this._next++).padStart(6, '0')}`;
    const created = this.now();
    const req = {
      id,
      bot: bot ? bot.name : null,
      tool,
      argsSummary: args === undefined ? null : String(args).slice(0, 200),
      reason: reason || null,
      status: 'pending',
      createdAt: created,
      expiresAt: created + (ttlMs ?? this.ttlMs),
      resolvedBy: null,
      resolution: null,
      resolvedAt: null,
    };
    this.requests.set(id, req);
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
      return { ok: false, error: 'expired' }; // fail closed
    }
    if (!approver || typeof approver !== 'string' || approver.length === 0)
      return { ok: false, error: 'approver_required' };
    if (verdict !== 'approve' && verdict !== 'deny') return { ok: false, error: 'bad_verdict' };
    req.status = verdict === 'approve' ? 'approved' : 'denied';
    req.resolvedBy = approver;
    req.resolvedAt = this.now();
    return { ok: true, request: req };
  }

  get(id) {
    const req = this.requests.get(id);
    if (!req) return null;
    if (this._expired(req)) req.status = 'expired';
    return req;
  }

  sweep() {
    for (const req of this.requests.values()) {
      if (this._expired(req)) req.status = 'expired';
    }
  }
}

module.exports = { ApprovalStore, DEFAULT_TTL_MS };