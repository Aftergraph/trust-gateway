'use strict';
// FS-E1d — tenant-scoped approvals + audit-chain READ scope (v1 surfaces).
//
// server.js owns the v1 routes (single-writer rule: never edited), so this
// mount INTERCEPTS the v1 paths BEFORE the built-in handlers run and either
// delegates or serves a scoped replica:
//
//   POST /v1/actions                       park/execute an action
//   GET  /v1/approvals                     list pending
//   POST /v1/approvals/:id/(approve|deny)  resolve
//   GET  /v1/audit                         read the chain
//   GET  /v1/audit/verify                  verify the chain
//
// SCOPE RULE (documented per the slice spec):
//   • main tenant  → this mount does NOT fire (returns undefined → the mount
//     runner treats it as a pass-through and the ORIGINAL server.js handler
//     runs byte-identically; singleton store, untagged chain payloads).
//   • non-main tenant (bearer prefix claim 'tnt_<id>_…' or operator
//     X-Tenant header) →
//       - /v1/actions park into a per-tenant ApprovalStore over
//         scopeDir(...,'approvals')/approvals.json; every audit entry the
//         scoped path writes carries tenantAuditTag(tenant) so /v2/search
//         and /v2/events can scope on it. allow-executions for tenant bots
//         run through the gateway dispatcher exactly like main.
//       - GET /v1/approvals lists ONLY that store's pending rows.
//       - /v1/approvals/:id/(approve|deny): cross-tenant ids are a uniform
//         404 (anti-enumeration); RBAC (canApprove) unchanged.
//       - GET /v1/audit returns ONLY entries tagged payload.tenant === id.
//       - GET /v1/audit/verify is an operator surface over the FULL chain →
//         non-main tenants get 404 (fail closed, anti-enumeration).
//   • auth is declared 'query'-style bypassed: this mount declares auth
//     'none' and performs the SAME bearer check in-handler (mounts run
//     before the v1 auth block in server.js) — token comparison identical,
//     every failure audited (auth_rejected) exactly like the v1 runner.
//
// NOTE: server.js has `if (mount.handle(...) !== undefined) return;`? No —
// mounts OWN the response. A mount that returns without sending would hang,
// so the main path here replicates the v1 handler bodies verbatim instead
// of delegating. The replication is pinned by tests/approvals-tenant.test.js
// ("main approvals byte-identical") + the untouched pre-existing suites.

const path = require('node:path');
const crypto = require('node:crypto');
const { send, readBody, canApprove } = require('../server');
const { resolveTenant } = require('../tenant-resolve');
const { enforceQuotas, scopeDir, tenantAuditTag } = require('../tenant-scope');
const { ApprovalStore } = require('../approvals');

const scopedStores = new WeakMap(); // gw → Map(tenantId → ApprovalStore)

function approvalsStoreFor(gw, tenant) {
  if (!tenant || tenant.id === 'main') return gw.approvals; // byte-identical
  let m = scopedStores.get(gw);
  if (!m) {
    m = new Map();
    scopedStores.set(gw, m);
  }
  let s = m.get(tenant.id);
  if (!s) {
    const dir = scopeDir(null, gw, tenant.id, 'approvals');
    s = new ApprovalStore({
      file: path.join(dir, 'approvals.json'),
      gw,
    });
    m.set(tenant.id, s);
  }
  return s;
}

function sha256(s) {
  return crypto.createHash('sha256').update(s).digest('hex');
}

// Bearer check identical to server.js _auth (timing-safe, bot lookup).
function authBot(gw, req) {
  const m = /^Bearer\s+(\S+)$/i.exec(req.headers.authorization || '');
  if (!m) return null;
  for (const [name, bot] of Object.entries(gw.bots)) {
    if (!bot || !bot.token) continue;
    const a = Buffer.from(String(bot.token));
    const b = Buffer.from(m[1]);
    if (a.length === b.length && crypto.timingSafeEqual(a, b)) {
      return { name, ...bot }; // name from the roster key — server.js contract
    }
  }
  return null;
}

module.exports = {
  name: 'v1-tenant-approvals',
  method: '*',
  path: /^\/v1\/(?:actions|approvals(?:\/[^/]+\/(?:approve|deny))?|audit(?:\/verify)?)$/,
  auth: 'none',
  handle: async (gw, req, res, ctx) => {
    const bot = authBot(gw, req);
    if (!bot) {
      gw._audit({ type: 'auth_rejected', path: ctx.url.pathname });
      return send(res, 401, { error: 'unauthorized' });
    }
    req.bot = bot; // resolver operator check
    const { tenant } = resolveTenant(req, gw);
    if (!tenant) return send(res, 404, { error: 'not_found' });
    if (enforceQuotas(gw, tenant, res)) return; // FS-I3: fail-closed quotas

    // ── MAIN: replicate the v1 handlers EXACTLY (untagged, singleton) ──
    if (tenant.id === 'main') return handleMain(gw, req, res, ctx, bot);

    // ── NON-MAIN: scoped stores + tagged audit + scoped reads ──────────
    return handleScoped(gw, req, res, ctx, bot, tenant);
  },
};

// ── main replication (byte-identical to server.js v1 handlers) ─────────
async function handleMain(gw, req, res, ctx, bot) {
  const url = ctx.url;
  const m = ctx.params.matches || [];

  if (req.method === 'POST' && url.pathname === '/v1/actions') {
    return gw._postAction(req, res, bot); // server.js parses + handles — byte-identical
  }

  if (req.method === 'POST' && /^\/v1\/approvals\/[^/]+\/(approve|deny)$/.test(url.pathname)) {
    return gw._postApproval(req, res, bot, url.pathname); // byte-identical
  }

  if (req.method === 'GET' && url.pathname === '/v1/approvals') {
    const pending = gw.approvals.listPending().map((r) => ({
      id: r.id, bot: r.bot, tool: r.tool, reason: r.reason,
      createdAt: r.createdAt, expiresAt: r.expiresAt,
    }));
    return send(res, 200, { pending });
  }

  if (req.method === 'GET' && url.pathname === '/v1/audit') {
    const since = Number(url.searchParams.get('since') || 0);
    const entries = gw.chain.since(since);
    return send(res, 200, { entries, head: gw.chain.head.hash, verified: gw.chain.verify() });
  }

  if (req.method === 'GET' && url.pathname === '/v1/audit/verify') {
    return send(res, 200, gw.chain.verify());
  }

  return send(res, 404, { error: 'not_found' });
}

// ── scoped handlers (non-main tenants) ─────────────────────────────────
async function handleScoped(gw, req, res, ctx, bot, tenant) {
  const url = ctx.url;
  const store = approvalsStoreFor(gw, tenant);

  // POST /v1/actions — same decision flow, scoped store + tagged audit
  if (req.method === 'POST' && url.pathname === '/v1/actions') {
    let body;
    try {
      body = JSON.parse(await readBody(req));
    } catch (e) {
      return send(res, 400, { error: 'invalid_json' });
    }
    const { classify, decide } = require('../policy');
    const tool = body.tool;
    const args = body.args ?? null;
    const cls = classify(tool);
    const verdict = decide({ tool, cls, bot });
    const tag = tenantAuditTag(tenant);
    const auditPayload = {
      type: 'action_decision',
      bot: bot.name,
      tool,
      class: cls,
      decision: verdict.decision,
      reason: verdict.reason,
      argsLength: args === undefined || args === null ? 0 : JSON.stringify(args).length,
      ...tag,
    };
    gw._audit(auditPayload);

    if (verdict.decision === 'deny') {
      return send(res, 403, { ...verdict, audited: true });
    }
    if (verdict.decision === 'needs_approval') {
      const approval = store.request({ bot, tool, args, reason: verdict.reason });
      gw._audit({ type: 'approval_requested', approvalId: approval.id, bot: bot.name, tool, class: cls, ...tag });
      gw._audit({
        type: 'approval_impact_snapshot',
        approvalId: approval.id,
        risk: approval.impact ? approval.impact.risk : 'destructive',
        confidence: approval.impact ? approval.impact.confidence : 'missing',
        ...tag,
      });
      return send(res, 202, { decision: 'needs_approval', approvalId: approval.id, reason: verdict.reason });
    }

    // allow → execute via the gateway dispatcher (same as main)
    if (!gw.dispatch && !gw._findExecutor(tool)) return send(res, 500, { error: 'no_dispatcher' });
    try {
      const result = await gw._run(bot.name, tool, args);
      gw._audit({ type: 'action_executed', bot: bot.name, tool, ok: true, ...tag });
      return send(res, 200, { decision: 'allow', result });
    } catch (e) {
      gw._audit({ type: 'action_executed', bot: bot.name, tool, ok: false, ...tag });
      return send(res, 502, { error: 'dispatch_failed' });
    }
  }

  // GET /v1/approvals — scoped store pending list (v1 lists for ANY
  // authenticated bot; scoping itself isolates tenants, so no RBAC gate
  // here — identical to the main route's contract).
  if (req.method === 'GET' && url.pathname === '/v1/approvals') {
    const pending = store.listPending().map((r) => ({
      id: r.id, bot: r.bot, tool: r.tool, reason: r.reason,
      createdAt: r.createdAt, expiresAt: r.expiresAt,
    }));
    return send(res, 200, { pending });
  }

  // POST /v1/approvals/:id/(approve|deny) — scoped resolve, RBAC unchanged
  const resolveMatch = /^\/v1\/approvals\/([^/]+)\/(approve|deny)$/.exec(url.pathname);
  if (req.method === 'POST' && resolveMatch) {
    if (!canApprove(bot)) {
      const parkedTool = (store.get(resolveMatch[1]) || {}).tool || null;
      gw._audit({
        type: 'approval_forbidden',
        approvalId: resolveMatch[1],
        bot: bot.name,
        tool: parkedTool,
        ...tenantAuditTag(tenant),
      });
      return send(res, 403, { error: 'operator_required' });
    }
    const approval = store.get(resolveMatch[1]);
    if (!approval) return send(res, 404, { error: 'not_found' }); // cross-tenant = uniform miss
    const verb = resolveMatch[2];
    const resolved = store.resolve(approval.id, verb, bot.name);
    gw._audit({
      type: 'approval_resolved',
      approvalId: approval.id,
      verb,
      approver: bot.name,
      bot: approval.bot && approval.bot.name,
      tool: approval.tool,
      ...tenantAuditTag(tenant),
    });
    if (verb === 'deny') return send(res, 200, { id: approval.id, status: 'denied' });
    // approve → execute through the dispatcher
    try {
      const result = await gw._run(approval.bot.name, approval.tool, approval.args);
      gw._audit({ type: 'action_executed_after_approval', approvalId: approval.id, bot: approval.bot.name, tool: approval.tool, ok: true, ...tenantAuditTag(tenant) });
      return send(res, 200, { id: approval.id, status: 'approved', result });
    } catch (e) {
      gw._audit({ type: 'action_executed_after_approval', approvalId: approval.id, bot: approval.bot.name, tool: approval.tool, ok: false, ...tenantAuditTag(tenant) });
      return send(res, 502, { error: 'dispatch_failed', detail: String(e && e.message).slice(0, 200) });
    }
  }

  // GET /v1/audit — ONLY own tagged entries
  if (req.method === 'GET' && url.pathname === '/v1/audit') {
    const since = Number(url.searchParams.get('since') || 0);
    const entries = gw.chain.since(since).filter(
      (e) => e.payload && e.payload.tenant === tenant.id
    );
    return send(res, 200, { entries, head: gw.chain.head.hash, verified: gw.chain.verify() });
  }

  // GET /v1/audit/verify — operator surface over the FULL chain: non-main → 404
  if (req.method === 'GET' && url.pathname === '/v1/audit/verify') {
    return send(res, 404, { error: 'not_found' });
  }

  return send(res, 404, { error: 'not_found' });
}

module.exports.approvalsStoreFor = approvalsStoreFor;