'use strict';

const { send } = require('../server');
const {
  buildDialagramEgressRequest,
  publicProviderResult,
  validateDialagramRequest,
} = require('../decision-provider-broker');

const MAX_BODY = 256 * 1024;

function canInvoke(bot) {
  if (!bot) return false;
  if (bot.role === 'owner' || bot.role === 'operator') return true;
  const caps = Array.isArray(bot.capabilities) ? bot.capabilities : [];
  return caps.includes('decision.provider.invoke') || caps.includes('*');
}

function safeErrorCode(error, fallback = 'decision_provider_rejected') {
  const code = String(error?.code || '');
  return /^[a-z0-9_]+$/.test(code) ? code : fallback;
}

async function readJson(req) {
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > MAX_BODY) {
      const error = new Error('body_too_large');
      error.code = 'body_too_large';
      throw error;
    }
    chunks.push(buffer);
  }
  if (chunks.length === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    const error = new Error('invalid_json');
    error.code = 'invalid_json';
    throw error;
  }
}

function config(env) {
  if (env.TG_DECISION_DIALAGRAM_BROKER !== '1') return null;
  const adapterId = String(env.TG_DECISION_DIALAGRAM_ADAPTER_ID || 'decision-dialagram').trim();
  const secretName = String(env.TG_DECISION_DIALAGRAM_SECRET_NAME || 'api-key').trim();
  const principalId = String(env.TG_DECISION_DIALAGRAM_PRINCIPAL_ID || '').trim();
  const missionId = String(env.TG_DECISION_DIALAGRAM_MISSION_ID || '').trim();
  const authorityRef = String(env.TG_DECISION_DIALAGRAM_AUTHORITY_REF || '').trim();
  const ttlMs = Number(env.TG_DECISION_DIALAGRAM_HANDLE_TTL_MS || 60_000);

  if (!adapterId || !secretName || !principalId || !missionId || !authorityRef) {
    return { error: 'decision_provider_configuration_incomplete' };
  }
  if (!Number.isInteger(ttlMs) || ttlMs < 1_000 || ttlMs > 10 * 60_000) {
    return { error: 'decision_provider_handle_ttl_invalid' };
  }
  return { adapterId, secretName, principalId, missionId, authorityRef, ttlMs };
}

module.exports = {
  name: 'v2-decision-providers',
  method: 'POST',
  path: /^\/v2\/decision-providers\/dialagram\/chat\/completions$/,
  auth: 'bearer',

  handle: async (gw, req, res, ctx) => {
    if (!canInvoke(ctx.bot)) {
      gw._audit({
        type: 'decision_provider_forbidden',
        provider: 'dialagram',
        bot: ctx.bot?.name || null,
        tenant: ctx.tenantId || null,
      });
      return send(res, 403, { error: 'decision_provider_forbidden' });
    }

    const cfg = config(process.env);
    if (!cfg) {
      gw._audit({
        type: 'decision_provider_blocked',
        provider: 'dialagram',
        bot: ctx.bot?.name || null,
        tenant: ctx.tenantId || null,
        reason: 'broker_disabled',
      });
      return send(res, 409, { error: 'decision_provider_broker_disabled' });
    }
    if (cfg.error) {
      gw._audit({
        type: 'decision_provider_blocked',
        provider: 'dialagram',
        bot: ctx.bot?.name || null,
        tenant: ctx.tenantId || null,
        reason: cfg.error,
      });
      return send(res, 409, { error: cfg.error });
    }

    if (!ctx.tenantId ||
        !gw.adapterCredentialLifecycle ||
        typeof gw.adapterCredentialLifecycle.issueHandle !== 'function' ||
        typeof gw.adapterCredentialLifecycle.revokeHandle !== 'function' ||
        !gw.governedEgressBroker ||
        gw.governedEgressBroker.requireAdapterBinding !== true ||
        typeof gw.governedEgressBroker.admit !== 'function' ||
        typeof gw.governedEgressBroker.dispatch !== 'function') {
      gw._audit({
        type: 'decision_provider_blocked',
        provider: 'dialagram',
        bot: ctx.bot?.name || null,
        tenant: ctx.tenantId || null,
        reason: 'governed_egress_required',
      });
      return send(res, 409, { error: 'governed_egress_required' });
    }

    let body;
    try {
      body = await readJson(req);
    } catch (error) {
      return send(res, error?.code === 'body_too_large' ? 413 : 400, {
        error: error?.code === 'body_too_large' ? 'body_too_large' : 'invalid_json',
      });
    }

    try {
      validateDialagramRequest(body);
    } catch (error) {
      const code = safeErrorCode(error);
      gw._audit({
        type: 'decision_provider_rejected',
        provider: 'dialagram',
        bot: ctx.bot?.name || null,
        tenant: ctx.tenantId || null,
        error: code,
        authorityGranted: false,
      });
      return send(res, 400, { error: code });
    }

    if (gw.budgets && typeof gw.budgets.consume === 'function') {
      const budget = gw.budgets.consume(ctx.bot.name);
      if (!budget?.ok) {
        gw._audit({
          type: 'budget_denied',
          bot: ctx.bot.name,
          tool: 'decision.provider.dialagram',
        });
        return send(res, 402, { error: 'budget_exhausted' });
      }
    }

    let handle = null;
    try {
      const now = typeof gw.now === 'function' ? Number(gw.now()) : Date.now();
      handle = gw.adapterCredentialLifecycle.issueHandle({
        tenant: ctx.tenantId,
        adapterId: cfg.adapterId,
        secretName: cfg.secretName,
        principalId: cfg.principalId,
        missionId: cfg.missionId,
        authorityRef: cfg.authorityRef,
        purpose: 'decision_provider_inference',
        credentialClass: 'api_token',
        allowedDestinations: ['dialagram.me'],
        allowedMethods: ['POST'],
        allowedPathPrefixes: ['/router/v1/chat/completions'],
        scopeRefs: ['decision-provider:dialagram'],
        expiresAt: now + cfg.ttlMs,
      });

      const request = buildDialagramEgressRequest({
        body,
        tenantId: ctx.tenantId,
        adapterId: cfg.adapterId,
        credentialHandle: handle.handleId,
        principalId: cfg.principalId,
        missionId: cfg.missionId,
        authorityRef: cfg.authorityRef,
        now: () => now,
      });

      const admission = await gw.governedEgressBroker.admit(request);
      const upstream = await gw.governedEgressBroker.dispatch(admission, request);
      const projected = publicProviderResult(upstream);

      gw._audit({
        type: 'decision_provider_brokered',
        provider: 'dialagram',
        model: typeof body?.model === 'string' ? body.model : null,
        status: projected.status,
        bot: ctx.bot?.name || null,
        tenant: ctx.tenantId,
        requestId: request.requestId,
        authorityGranted: false,
      });
      return send(res, projected.status, projected.body);
    } catch (error) {
      const code = safeErrorCode(error);
      gw._audit({
        type: 'decision_provider_rejected',
        provider: 'dialagram',
        bot: ctx.bot?.name || null,
        tenant: ctx.tenantId || null,
        error: code,
        authorityGranted: false,
      });
      return send(res, 409, { error: code });
    } finally {
      if (handle?.handleId) {
        try {
          gw.adapterCredentialLifecycle.revokeHandle({
            handleId: handle.handleId,
            tenant: ctx.tenantId,
            adapterId: cfg.adapterId,
            reason: 'decision_provider_request_complete',
          });
        } catch (error) {
          gw._audit({
            type: 'decision_provider_handle_revoke_failed',
            provider: 'dialagram',
            tenant: ctx.tenantId || null,
            error: safeErrorCode(error, 'handle_revoke_failed'),
          });
        }
      }
    }
  },
};
