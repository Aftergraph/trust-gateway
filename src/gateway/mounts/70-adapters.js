'use strict';
// C4 mount — adapter registry HTTP surface. ONE RegExp mount covers the whole
// /v2/adapters tree (single registration, wave C mount pattern):
//
//   GET    /v2/adapters              → secret-free list
//   POST   /v2/adapters              → register {kind, name, config}
//   GET    /v2/adapters/:id          → secret-free projection
//   PATCH  /v2/adapters/:id          → update {name?, config?, enabled?}
//   DELETE /v2/adapters/:id          → remove
//   POST   /v2/adapters/:id/test     → governed probe or fail-closed 409
//   POST   /v2/adapters/:id/secret   → governed credential flow or 409
//
// Every mutation and every probe is audited via gw._audit with hostnames
// only — never a URL with credentials, never a secret value.
// Auth: bearer (validated by the mount runner before this handler runs).

const { send } = require('../server');
const { getAdapters } = require('../adapters-singleton');
const {
  buildWebhookProbeRequest,
  buildHttpApiProbeRequest,
  runGovernedAdapterProbe,
} = require('../governed-adapter-probe');

const MAX_BODY = 64 * 1024;

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) { reject(new Error('body_too_large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

async function readJson(req) {
  const raw = await readBody(req);
  if (!raw) return {};
  return JSON.parse(raw); // throws on bad JSON
}

// never log a URL — secrets hide in query strings and credentials
function auditTarget(def) {
  if (!def) return null;
  const cfg = def.config || {};
  const raw = cfg.url || cfg.baseUrl || '';
  let host = null;
  try { host = new URL(String(raw)).host; } catch { host = null; }
  return host || null;
}

function canManageCredentials(bot) {
  if (!bot) return false;
  if (bot.role === 'operator' || bot.role === 'owner') return true;
  const caps = Array.isArray(bot.capabilities) ? bot.capabilities : [];
  return caps.includes('adapter.credentials.write') || caps.includes('*');
}

function canManageAdapters(bot) {
  if (!bot) return false;
  if (bot.role === 'operator' || bot.role === 'owner') return true;
  const caps = Array.isArray(bot.capabilities) ? bot.capabilities : [];
  return caps.includes('adapter.manage') || caps.includes('*');
}

function safeErrorCode(error, fallback) {
  const code = String(error?.code || '');
  return /^[a-z0-9_]+$/.test(code) ? code : fallback;
}

module.exports = {
  name: 'v2-adapters',
  method: '*',
  // 'kinds' is owned by 99-adapter-kinds (G9 data-driven registry) — the
  // id segment here must not swallow it.
  path: /^\/v2\/adapters(\/(?!kinds(?:\/|$))[\w-]+)?(\/test|\/secret|\/handle(?:\/[\w-]+)?(?:\/revoke)?)?$/,
  auth: 'bearer',
  handle: async (gw, req, res, ctx) => {
    const reg = getAdapters(gw);
    const m = ctx.params.matches || [];
    const id = m[1] ? m[1].slice(1) : null; // strip leading slash
    const actionPath = m[2] ? m[2].slice(1) : '';
    const actionParts = actionPath ? actionPath.split('/') : [];
    const action = actionParts[0] || null; // 'test' | 'secret' | 'handle' | null
    const handleId = action === 'handle' ? (actionParts[1] || null) : null;
    const handleAction = action === 'handle' ? (actionParts[2] || null) : null;

    // ── POST|GET /v2/adapters/:id/handle ───────────────────────────────────
    // Handle control-plane operations are intentionally separate from probing:
    // the opaque handle is issued/revoked by the tenant-scoped lifecycle, while
    // authority and approval are still enforced later by GovernedEgressBroker.
    if (action === 'handle') {
      const def = reg.get(id);
      if (!def) return send(res, 404, { error: 'not_found' });

      if (!canManageCredentials(ctx.bot)) {
        gw._audit({
          type: 'adapter_handle_forbidden',
          id,
          tenant: ctx.tenantId || null,
          bot: ctx.bot?.name || null,
          reason: 'operator_required',
        });
        return send(res, 403, { error: 'operator_required' });
      }
      if (!gw.adapterCredentialLifecycle ||
          typeof gw.adapterCredentialLifecycle.issueHandle !== 'function' ||
          typeof gw.adapterCredentialLifecycle.inspectHandle !== 'function' ||
          typeof gw.adapterCredentialLifecycle.revokeHandle !== 'function') {
        gw._audit({
          type: 'adapter_handle_blocked',
          id,
          tenant: ctx.tenantId || null,
          bot: ctx.bot?.name || null,
          reason: 'governed_credentials_required',
        });
        return send(res, 409, { error: 'governed_credentials_required' });
      }

      if (req.method === 'GET' && handleId && !handleAction) {
        try {
          const inspected = gw.adapterCredentialLifecycle.inspectHandle({
            handleId,
            tenant: ctx.tenantId,
            adapterId: id,
          });
          const { secret, secretKey, ...publicHandle } = inspected || {};
          gw._audit({
            type: 'adapter_handle_inspected',
            id,
            tenant: ctx.tenantId || null,
            bot: ctx.bot?.name || null,
          });
          return send(res, 200, { handle: publicHandle });
        } catch (e) {
          const error = safeErrorCode(e, 'adapter_handle_rejected');
          gw._audit({
            type: 'adapter_handle_rejected',
            id,
            tenant: ctx.tenantId || null,
            bot: ctx.bot?.name || null,
            error,
          });
          return send(res, 404, { error });
        }
      }

      if (req.method === 'POST' && !handleId && !handleAction) {
        let body;
        try { body = await readJson(req); } catch (e) {
          return send(res, e.message === 'body_too_large' ? 413 : 400, { error: e.message === 'body_too_large' ? 'body_too_large' : 'invalid_json' });
        }
        const allowed = new Set([
          'secretName', 'principalId', 'missionId', 'authorityRef',
          'credentialClass', 'allowedDestinations', 'allowedMethods',
          'allowedPathPrefixes', 'scopeRefs', 'expiresAt',
        ]);
        if (!body || typeof body !== 'object' || Array.isArray(body) ||
            Object.keys(body).some((key) => !allowed.has(key))) {
          return send(res, 400, { error: 'invalid_body' });
        }
        try {
          const issued = gw.adapterCredentialLifecycle.issueHandle({
            ...body,
            tenant: ctx.tenantId,
            adapterId: id,
            purpose: 'adapter_probe',
          });
          const { secret, secretKey, ...publicHandle } = issued || {};
          gw._audit({
            type: 'adapter_handle_issued',
            id,
            tenant: ctx.tenantId || null,
            bot: ctx.bot?.name || null,
            secretName: publicHandle.secretName || null,
          });
          return send(res, 201, { handle: publicHandle });
        } catch (e) {
          const error = safeErrorCode(e, 'adapter_handle_rejected');
          gw._audit({
            type: 'adapter_handle_rejected',
            id,
            tenant: ctx.tenantId || null,
            bot: ctx.bot?.name || null,
            error,
          });
          return send(res, 400, { error });
        }
      }

      if (req.method === 'POST' && handleId && handleAction === 'revoke') {
        let body;
        try { body = await readJson(req); } catch (e) {
          return send(res, e.message === 'body_too_large' ? 413 : 400, { error: e.message === 'body_too_large' ? 'body_too_large' : 'invalid_json' });
        }
        if (!body || typeof body !== 'object' || Array.isArray(body) ||
            Object.keys(body).some((key) => key !== 'reason')) {
          return send(res, 400, { error: 'invalid_body' });
        }
        try {
          const revoked = gw.adapterCredentialLifecycle.revokeHandle({
            handleId,
            tenant: ctx.tenantId,
            adapterId: id,
            reason: body.reason,
          });
          const { secret, secretKey, ...publicHandle } = revoked || {};
          gw._audit({
            type: 'adapter_handle_revoked',
            id,
            tenant: ctx.tenantId || null,
            bot: ctx.bot?.name || null,
          });
          return send(res, 200, { handle: publicHandle });
        } catch (e) {
          const error = safeErrorCode(e, 'adapter_handle_rejected');
          gw._audit({
            type: 'adapter_handle_rejected',
            id,
            tenant: ctx.tenantId || null,
            bot: ctx.bot?.name || null,
            error,
          });
          return send(res, 404, { error });
        }
      }

      return send(res, 405, { error: 'method_not_allowed' });
    }

    // ── GET ────────────────────────────────────────────────────────────────
    if (req.method === 'GET') {
      if (id) {
        const def = reg.get(id);
        if (!def) return send(res, 404, { error: 'not_found' });
        return send(res, 200, { adapter: reg.project(def) });
      }
      return send(res, 200, { adapters: reg.list().map((d) => reg.project(d)) });
    }

    if (req.method !== 'POST' && !(req.method === 'DELETE' && id) && !(req.method === 'PATCH' && id)) {
      return send(res, 405, { error: 'method_not_allowed' });
    }

    // ── POST /v2/adapters/:id/test ─────────────────────────────────────────
    if (action === 'test') {
      if (req.method !== 'POST') return send(res, 405, { error: 'method_not_allowed' });
      const def = reg.get(id);
      if (!def) return send(res, 404, { error: 'not_found' });

      // The legacy registry probe is deliberately unreachable from HTTP.
      // An adapter route is live only when the embedding control plane injects
      // both a trusted context resolver and an adapter-bound broker.
      if (typeof gw.adapterContextResolver !== 'function' ||
          !gw.governedEgressBroker || gw.governedEgressBroker.requireAdapterBinding !== true ||
          typeof gw.governedEgressBroker.admit !== 'function' ||
          typeof gw.governedEgressBroker.dispatch !== 'function') {
        gw._audit({
          type: 'adapter_test_blocked',
          id,
          tenant: ctx.tenantId || null,
          bot: ctx.bot?.name || null,
          reason: 'governed_egress_required',
        });
        return send(res, 409, { error: 'governed_egress_required' });
      }

      let body;
      try { body = await readJson(req); } catch (e) {
        return send(res, e.message === 'body_too_large' ? 413 : 400, { error: e.message === 'body_too_large' ? 'body_too_large' : 'invalid_json' });
      }
      if (!body || typeof body !== 'object' || Array.isArray(body) ||
          Object.keys(body).some((key) => key !== 'credentialHandle') ||
          typeof body.credentialHandle !== 'string' || body.credentialHandle.trim() === '') {
        return send(res, 400, { error: 'invalid_body' });
      }

      try {
        // The resolver is the only source for principal/mission/authority
        // context. Tenant and adapter identity are overwritten from the
        // authenticated route, never accepted from the body or resolver.
        const resolved = await gw.adapterContextResolver({
          req,
          ctx,
          adapter: def,
          adapterId: id,
          credentialHandle: body.credentialHandle,
        });
        const context = {
          ...(resolved || {}),
          tenantId: ctx.tenantId,
          adapterId: id,
          purpose: 'adapter_probe',
          credentialHandle: body.credentialHandle,
        };
        const request = def.kind === 'webhook'
          ? buildWebhookProbeRequest(def, context)
          : def.kind === 'http-api'
            ? buildHttpApiProbeRequest(def, context)
            : (() => { throw Object.assign(new Error('adapter_probe_unsupported'), { code: 'adapter_probe_unsupported' }); })();
        const result = await runGovernedAdapterProbe({ broker: gw.governedEgressBroker, request });
        const status = Number(result?.status || 0);
        gw._audit({
          type: 'adapter_test_governed',
          id,
          tenant: ctx.tenantId || null,
          bot: ctx.bot?.name || null,
          status,
        });
        return send(res, 200, { adapterId: id, ok: status >= 200 && status < 300, status });
      } catch (e) {
        const error = safeErrorCode(e, 'governed_egress_rejected');
        gw._audit({
          type: 'adapter_test_rejected',
          id,
          tenant: ctx.tenantId || null,
          bot: ctx.bot?.name || null,
          error,
        });
        return send(res, 409, { error });
      }
    }

    // ── POST /v2/adapters/:id/secret ────────────────────────────────────────
    if (action === 'secret') {
      if (req.method !== 'POST') return send(res, 405, { error: 'method_not_allowed' });
      const def = reg.get(id);
      if (!def) return send(res, 404, { error: 'not_found' });

      // Credential writes are operator/capability controlled and go only to
      // the tenant-scoped Vault lifecycle. Workers cannot cause body parsing.
      if (!canManageCredentials(ctx.bot)) {
        gw._audit({
          type: 'adapter_credentials_forbidden',
          id,
          tenant: ctx.tenantId || null,
          bot: ctx.bot?.name || null,
          reason: 'operator_required',
        });
        return send(res, 403, { error: 'operator_required' });
      }
      if (!gw.adapterCredentialLifecycle || typeof gw.adapterCredentialLifecycle.setSecret !== 'function') {
        gw._audit({
          type: 'adapter_credentials_blocked',
          id,
          tenant: ctx.tenantId || null,
          bot: ctx.bot?.name || null,
          reason: 'governed_credentials_required',
        });
        return send(res, 409, { error: 'governed_credentials_required' });
      }

      let body;
      try { body = await readJson(req); } catch (e) {
        return send(res, e.message === 'body_too_large' ? 413 : 400, { error: e.message === 'body_too_large' ? 'body_too_large' : 'invalid_json' });
      }
      if (!body || typeof body !== 'object' || Array.isArray(body)) return send(res, 400, { error: 'invalid_body' });
      try {
        const out = gw.adapterCredentialLifecycle.setSecret({
          tenant: ctx.tenantId,
          adapterId: id,
          secretName: body.secretName ?? body.name,
          value: body.value,
        });
        gw._audit({
          type: 'adapter_credentials_set',
          id,
          tenant: ctx.tenantId || null,
          bot: ctx.bot?.name || null,
          secretName: out?.secretName || null,
        });
        return send(res, 201, {
          credential: {
            adapterId: out?.adapterId || id,
            secretName: out?.secretName || String(body.secretName ?? body.name ?? ''),
          },
        });
      } catch (e) {
        const error = safeErrorCode(e, 'adapter_credentials_rejected');
        gw._audit({
          type: 'adapter_credentials_rejected',
          id,
          tenant: ctx.tenantId || null,
          bot: ctx.bot?.name || null,
          error,
        });
        return send(res, 400, { error });
      }
    }
    // Adapter registry mutations are control-plane operations. Workers may
    // probe through the governed route, but may not register, reconfigure, or
    // delete an adapter unless explicitly granted adapter.manage.
    const isManagementMutation = (!id && req.method === 'POST') ||
      (id && !action && (req.method === 'PATCH' || req.method === 'DELETE'));
    if (isManagementMutation && !canManageAdapters(ctx.bot)) {
      gw._audit({
        type: 'adapter_management_forbidden',
        id: id || null,
        tenant: ctx.tenantId || null,
        bot: ctx.bot?.name || null,
        reason: 'operator_required',
      });
      return send(res, 403, { error: 'operator_required' });
    }

    // ── POST /v2/adapters (register) ───────────────────────────────────────
    if (!id) {
      if (req.method !== 'POST') return send(res, 405, { error: 'method_not_allowed' });
      let body;
      try { body = await readJson(req); } catch (e) {
        return send(res, e.message === 'body_too_large' ? 413 : 400, { error: e.message === 'body_too_large' ? 'body_too_large' : 'invalid_json' });
      }
      if (!body || typeof body !== 'object') return send(res, 400, { error: 'invalid_body' });
      let def;
      try {
        def = reg.register({ kind: body.kind, name: body.name, config: body.config });
      } catch (e) {
        return send(res, 400, { error: 'invalid_adapter', detail: String(e && e.message).replace(/^invalid_adapter: /, '') });
      }
      gw._audit({ type: 'adapter_registered', id: def.id, kind: def.kind, name: def.name });
      return send(res, 201, { adapter: reg.project(def) });
    }

    // ── PATCH /v2/adapters/:id (update) ────────────────────────────────────
    if (req.method === 'PATCH') {
      let body;
      try { body = await readJson(req); } catch (e) {
        return send(res, e.message === 'body_too_large' ? 413 : 400, { error: e.message === 'body_too_large' ? 'body_too_large' : 'invalid_json' });
      }
      if (!body || typeof body !== 'object') return send(res, 400, { error: 'invalid_body' });
      let def;
      try { def = reg.update(id, body); } catch (e) {
        return send(res, 400, { error: 'invalid_adapter', detail: String(e && e.message).replace(/^invalid_adapter: /, '') });
      }
      if (!def) return send(res, 404, { error: 'not_found' });
      gw._audit({ type: 'adapter_updated', id: def.id });
      return send(res, 200, { adapter: reg.project(def) });
    }

    // ── DELETE /v2/adapters/:id ────────────────────────────────────────────
    if (req.method === 'DELETE') {
      const def = reg.remove(id);
      if (!def) return send(res, 404, { error: 'not_found' });
      gw._audit({ type: 'adapter_deleted', id: def.id, kind: def.kind });
      return send(res, 200, { ok: true, id });
    }

    return send(res, 405, { error: 'method_not_allowed' });
  },
};