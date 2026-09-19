'use strict';

const { resolvePlatformIdentity } = require('./platform-identity');
const { getExecutionContext } = require('./works-context-client');
const { revalidate } = require('./aie-client');
const { createExecutionDecision } = require('./policy-decision-record');

const ACTION_RE = /^act_[a-f0-9]{32}$/u;
const CTX_RE = /^ctx_[a-f0-9]{32}$/u;

function deny(status, error, detail) {
  const e = new Error(error);
  e.status = status;
  e.code = error;
  if (detail) e.detail = detail;
  return e;
}

async function authorizeV21Action({ req, gw, body, bot, tool, args, deps = {} }) {
  const resolveIdentity = deps.resolvePlatformIdentity || resolvePlatformIdentity;
  const loadContext = deps.getExecutionContext || getExecutionContext;
  const liveRevalidate = deps.revalidate || revalidate;
  const persistDecision = deps.createExecutionDecision || createExecutionDecision;
  const executionContextId = body.execution_context_id;
  if (executionContextId === undefined || executionContextId === null) {
    return { legacy: true };
  }
  if (typeof executionContextId !== 'string' || !CTX_RE.test(executionContextId)) {
    throw deny(400, 'invalid_execution_context_id');
  }
  if (typeof body.action_id !== 'string' || !ACTION_RE.test(body.action_id)) {
    throw deny(400, 'invalid_action_id');
  }

  const identity = resolveIdentity(req, gw);
  if (!identity || identity.status !== 200) {
    throw deny(identity && identity.status || 503, identity && identity.body && identity.body.error || 'platform_identity_unavailable');
  }

  const loaded = await loadContext(executionContextId);
  if (!loaded.ok) {
    const status = loaded.reason === 'execution_context_not_found' ? 404 :
      loaded.reason === 'invalid_execution_context_id' ? 400 : 503;
    throw deny(status, loaded.reason);
  }
  const context = loaded.context;
  const current = identity.body;

  if (context.organization_id !== current.organization_id ||
      context.tenant_id !== current.tenant_id ||
      context.principal_id !== current.principal_id) {
    throw deny(403, 'execution_context_identity_mismatch');
  }
  if (body.mission_id !== undefined && body.mission_id !== context.mission_id) {
    throw deny(403, 'execution_context_mission_mismatch');
  }

  const rv = liveRevalidate(body.action_id, { bot: bot.name, tool, args });
  if (!rv.ok) {
    let status = 403;
    let error = 'revalidation_failed';
    if (rv.code === 'AIE-AUTH-002') { status = 410; error = 'lease_expired'; }
    else if (rv.code === 'AIE-AUTH-003') error = 'authority_revoked';
    else if (rv.code === 'AIE-AUTH-004') error = 'action_not_admitted';
    else if (rv.code === 'AIE_UNREACHABLE') { status = 502; error = 'aie_unreachable'; }
    throw deny(status, error, rv.code);
  }
  if (rv.action_id !== body.action_id || rv.authority_lease_id !== context.authority_lease_id) {
    throw deny(403, 'execution_context_authority_mismatch');
  }

  const pdr = persistDecision({
    action_id: body.action_id,
    phase: 'execution',
    tenant_id: context.tenant_id,
    principal_id: context.principal_id,
    mission_id: context.mission_id,
    authority_lease_id: context.authority_lease_id,
    execution_context_id: context.execution_context_id,
    allow: true,
    reason: 'admitted',
  });

  return { legacy: false, context, pdr, identity: current, revalidation: rv };
}

module.exports = { authorizeV21Action };
