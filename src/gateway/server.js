'use strict';
// Trust Gateway — HTTP API. Write-ahead audit: the decision is recorded
// BEFORE any dispatcher runs, so refusals and crashes are on the record too.

const http = require('node:http');
const { HashChain, canonical } = require('./hash-chain');
const { classify, decide } = require('./policy');
const { ApprovalStore } = require('./approvals');

const MAX_BODY = 256 * 1024;

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(new Error('body_too_large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function send(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(body);
}

class Gateway {
  constructor({
    bots = {},            // name -> { token, capabilities, role }
    dispatch = null,      // async (tool, args) -> result object
    chain = null,
    approvals = null,
    now = () => Date.now(),
  } = {}) {
    this.bots = bots;
    this.dispatch = dispatch;
    this.chain = chain ?? new HashChain();
    this.approvals = approvals ?? new ApprovalStore({ now });
    this.now = now;
    this._pendingDecisions = new Map(); // approvalId -> {bot, tool, args, cls}
  }

  _auth(req) {
    const h = req.headers['authorization'] || '';
    const m = /^Bearer\s+(.+)$/i.exec(h);
    if (!m) return null;
    const token = m[1];
    for (const [name, bot] of Object.entries(this.bots)) {
      if (bot.token && cryptoSafeEqual(bot.token, token)) return { name, ...bot };
    }
    return null;
  }

  _audit(payload) {
    return this.chain.append(payload, this.now());
  }

  async handle(req, res) {
    const url = new URL(req.url, 'http://localhost');
    const path = url.pathname;

    if (req.method === 'GET' && path === '/healthz') {
      return send(res, 200, { ok: true, chain: this.chain.verify() });
    }

    // Everything else requires auth.
    const bot = this._auth(req);
    if (!bot) {
      this._audit({ type: 'auth_rejected', path });
      return send(res, 401, { error: 'unauthorized' });
    }

    if (req.method === 'POST' && path === '/v1/actions') {
      return this._postAction(req, res, bot);
    }
    if (req.method === 'POST' && /^\/v1\/approvals\/[^/]+\/(approve|deny)$/.test(path)) {
      return this._postApproval(req, res, bot, path);
    }
    if (req.method === 'GET' && path === '/v1/audit') {
      const since = Number(url.searchParams.get('since') || 0);
      const entries = this.chain.since(since);
      return send(res, 200, { entries, head: this.chain.head.hash, verified: this.chain.verify() });
    }
    if (req.method === 'GET' && path === '/v1/audit/verify') {
      return send(res, 200, this.chain.verify());
    }
    return send(res, 404, { error: 'not_found' });
  }

  async _postAction(req, res, bot) {
    let body;
    try {
      body = JSON.parse(await readBody(req));
    } catch (e) {
      return send(res, 400, { error: 'invalid_json' });
    }
    const tool = body.tool;
    const args = body.args ?? null;
    const cls = classify(tool);
    const verdict = decide({ tool, cls, bot });

    // Write-ahead audit of the DECISION.
    const auditPayload = {
      type: 'action_decision',
      bot: bot.name,
      tool,
      class: cls,
      decision: verdict.decision,
      reason: verdict.reason,
      // Never store secret values; store length only.
      argsLength: args === undefined || args === null ? 0 : JSON.stringify(args).length,
    };
    this._audit(auditPayload);

    if (verdict.decision === 'deny') {
      return send(res, 403, { ...verdict, audited: true });
    }
    if (verdict.decision === 'needs_approval') {
      const approval = this.approvals.request({
        bot,
        tool,
        args,
        reason: verdict.reason,
      });
      this._pendingDecisions.set(approval.id, { botName: bot.name, tool, args, cls });
      this._audit({ type: 'approval_requested', approvalId: approval.id, bot: bot.name, tool, class: cls });
      return send(res, 202, { decision: 'needs_approval', approvalId: approval.id, reason: verdict.reason });
    }

    // allow → dispatch
    if (!this.dispatch) return send(res, 500, { error: 'no_dispatcher' });
    try {
      const result = await this.dispatch(tool, args);
      this._audit({ type: 'action_executed', bot: bot.name, tool, ok: true });
      return send(res, 200, { decision: 'allow', result });
    } catch (e) {
      this._audit({ type: 'action_executed', bot: bot.name, tool, ok: false, error: String(e && e.message) });
      return send(res, 502, { decision: 'allow', error: 'dispatch_failed' });
    }
  }

  async _postApproval(req, res, bot, path) {
    const m = path.match(/^\/v1\/approvals\/([^/]+)\/(approve|deny)$/);
    const [, id, verb] = m;
    const approver = bot.name; // in v1, any authenticated bot may approve (operator role expected)
    const result = this.approvals.resolve(id, verb, approver);
    this._audit({
      type: 'approval_resolved',
      approvalId: id,
      verb,
      approver,
      ok: result.ok,
      error: result.ok ? undefined : result.error,
    });
    if (!result.ok) {
      const status = result.error === 'not_found' ? 404 : 409;
      return send(res, status, result);
    }
    if (verb === 'deny') return send(res, 200, { id, status: 'denied' });

    // Approved → execute the parked decision.
    const parked = this._pendingDecisions.get(id);
    if (!parked) return send(res, 500, { error: 'parked_action_missing' });
    this._pendingDecisions.delete(id);
    if (!this.dispatch) return send(res, 500, { error: 'no_dispatcher' });
    try {
      const out2 = await this.dispatch(parked.tool, parked.args);
      this._audit({ type: 'action_executed_after_approval', approvalId: id, tool: parked.tool, ok: true });
      return send(res, 200, { id, status: 'approved', result: out2 });
    } catch (e) {
      this._audit({ type: 'action_executed_after_approval', approvalId: id, tool: parked.tool, ok: false });
      return send(res, 502, { id, status: 'approved', error: 'dispatch_failed' });
    }
  }
}

function cryptoSafeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}
const crypto = require('node:crypto');

module.exports = { Gateway, send, readBody, canonical };