'use strict';

const { evaluateToolActionRequest } = require('../tool-fabric-actions');
const { isOperator } = require('../tenants');
const { resolveTenant } = require('../tenant-resolve');
const { audit } = require('../events');
const { createFileToolFabricResolverFromEnv } = require('../tool-fabric-resolver');
const { getToolActionProposalStore } = require('../tool-action-proposals');
const { getNeedsYouStore } = require('../needsyou');

const MAX_BODY_BYTES = 64 * 1024;

function sendJson(res, status, body) {
  res.setHeader('Content-Type', 'application/json');
  res.statusCode = status;
  res.end(JSON.stringify(body));
}

async function readJson(req) {
  let body = '';
  let bytes = 0;
  await new Promise((resolve, reject) => {
    req.on('data', chunk => {
      bytes += Buffer.byteLength(chunk);
      if (bytes <= MAX_BODY_BYTES) body += chunk;
    });
    req.on('end', resolve);
    req.on('error', reject);
  });
  if (bytes > MAX_BODY_BYTES) return { ok: false, status: 413, error: 'request_too_large' };
  try { return { ok: true, value: JSON.parse(body || '{}') }; }
  catch { return { ok: false, status: 400, error: 'invalid_json' }; }
}

function safeProposalView(proposal) {
  if (!proposal) return null;
  return {
    schemaVersion: proposal.schemaVersion,
    requestId: proposal.requestId,
    tenantId: proposal.tenantId,
    toolId: proposal.toolId,
    capability: proposal.capability,
    toolProvenanceDigest: proposal.toolProvenanceDigest,
    principalId: proposal.principalId,
    missionId: proposal.missionId,
    executionContextId: proposal.executionContextId,
    argumentsDigest: proposal.argumentsDigest,
    classification: proposal.classification,
    reasonCode: proposal.reasonCode,
    state: proposal.state,
    approvalId: proposal.needsYouId,
    createdAt: proposal.createdAt,
    updatedAt: proposal.updatedAt,
    expiresAt: proposal.expiresAt,
    resolvedAt: proposal.resolvedAt,
    resolvedBy: proposal.resolvedBy,
    dispatchRef: proposal.dispatchRef,
    receiptRef: proposal.receiptRef,
    authorityGranted: false,
    credentialMaterialPresent: false,
  };
}

function requestIdFrom(url, resolveRoute = false) {
  const pathname = String(url || '').split('?')[0];
  const parts = pathname.split('/').filter(Boolean);
  if (parts[0] !== 'v2' || parts[1] !== 'tool-fabric' || parts[2] !== 'actions') return null;
  if (resolveRoute) {
    if (parts.length !== 5 || parts[4] !== 'resolve') return null;
  } else if (parts.length !== 4) {
    return null;
  }
  try { return decodeURIComponent(parts[3]); } catch { return null; }
}

function parseNeedsYouDetails(item) {
  if (!item || typeof item.details !== 'string') return null;
  try {
    const parsed = JSON.parse(item.details);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

function proposalMatchesNeedsYou(proposal, item) {
  if (!proposal || !item || item.type !== 'approval') return false;
  const details = parseNeedsYouDetails(item);
  if (!details) return false;
  return details.requestId === proposal.requestId &&
    details.toolId === proposal.toolId &&
    details.capability === proposal.capability &&
    details.missionId === proposal.missionId &&
    details.executionContextId === proposal.executionContextId;
}

module.exports = function mountToolFabricActions(gw) {
  const fileResolver = createFileToolFabricResolverFromEnv();
  const proposalStore = getToolActionProposalStore(gw);
  const needsYouStore = getNeedsYouStore(gw);
  const resolver = () => gw.toolFabricResolver || fileResolver;
  const reconcileExpiredNeedsYou = (proposal) => {
    if (!proposal || proposal.state !== 'expired' || !proposal.needsYouId) return;
    const item = needsYouStore.get(proposal.needsYouId);
    if (item && item.status === 'open') {
      const resolved = needsYouStore.resolve(item.id, 'tool-action-expiry');
      if (resolved.ok) {
        audit('tool_action_needsyou_expired', {
          requestId: proposal.requestId,
          approvalId: item.id,
          tenantId: proposal.tenantId,
        });
      }
    }
  };

  gw.router.post('/v2/tool-fabric/actions/request', async (req, res) => {
    const op = isOperator(req);
    if (!op) return sendJson(res, 403, { error: 'operator_required' });

    const { tenant } = resolveTenant(req, gw);
    if (!tenant) return sendJson(res, 404, { error: 'not_found' });

    const parsed = await readJson(req);
    if (!parsed.ok) return sendJson(res, parsed.status, { error: parsed.error });

    const evaluated = await evaluateToolActionRequest({
      request: parsed.value,
      resolver: resolver(),
      bot: req.bot,
    });

    if (!evaluated.body.classification) {
      return sendJson(res, evaluated.status, evaluated.body);
    }

    const persisted = proposalStore.createOrGet({
      tenantId: tenant.id,
      request: parsed.value,
      admission: evaluated.body,
    });
    if (!persisted.ok) {
      audit('tool_action_proposal_conflict', {
        by: op.name,
        requestId: parsed.value?.requestId || null,
        tenantId: tenant.id,
        reason: persisted.error,
      });
      return sendJson(res, 409, {
        error: persisted.error,
        proposal: safeProposalView(persisted.proposal),
      });
    }

    let proposal = persisted.proposal;
    reconcileExpiredNeedsYou(proposal);
    if (proposal.state === 'pending_approval' && !proposal.needsYouId) {
      const item = needsYouStore.create({
        tenantId: tenant.id,
        type: 'approval',
        subject: `Tool action: ${proposal.toolId} / ${proposal.capability}`,
        details: JSON.stringify({
          schemaVersion: 'aftergraph.tool-action-needs-you/v1',
          requestId: proposal.requestId,
          toolId: proposal.toolId,
          capability: proposal.capability,
          missionId: proposal.missionId,
          executionContextId: proposal.executionContextId,
          reasonCode: proposal.reasonCode,
        }),
      });
      const attached = proposalStore.attachNeedsYou(proposal.requestId, item.id);
      if (!attached.ok) return sendJson(res, 409, { error: attached.error });
      proposal = attached.proposal;
      audit('tool_action_needsyou_created', {
        by: op.name,
        requestId: proposal.requestId,
        approvalId: item.id,
        tenantId: tenant.id,
        toolId: proposal.toolId,
        capability: proposal.capability,
      });
    }

    audit('tool_action_admission', {
      by: op.name,
      requestId: proposal.requestId,
      toolId: proposal.toolId,
      capability: proposal.capability,
      missionId: proposal.missionId,
      executionContextId: proposal.executionContextId,
      tenantId: tenant.id,
      decision: proposal.state,
      reasonCode: proposal.reasonCode,
      approvalId: proposal.needsYouId,
    });

    const response = {
      ...evaluated.body,
      decision: proposal.state,
      approvalId: proposal.needsYouId,
      proposal: safeProposalView(proposal),
    };
    const status = proposal.state === 'admitted' ? 200
      : proposal.state === 'pending_approval' ? 409
        : 403;
    return sendJson(res, status, response);
  });

  gw.router.get('/v2/tool-fabric/actions/:requestId', async (req, res) => {
    const op = isOperator(req);
    if (!op) return sendJson(res, 403, { error: 'operator_required' });
    const { tenant } = resolveTenant(req, gw);
    if (!tenant) return sendJson(res, 404, { error: 'not_found' });

    const requestId = requestIdFrom(req.url);
    const proposal = proposalStore.get(requestId);
    reconcileExpiredNeedsYou(proposal);
    if (!proposal || proposal.tenantId !== tenant.id) return sendJson(res, 404, { error: 'not_found' });
    return sendJson(res, 200, { proposal: safeProposalView(proposal) });
  });

  gw.router.post('/v2/tool-fabric/actions/:requestId/resolve', async (req, res) => {
    const op = isOperator(req);
    if (!op) return sendJson(res, 403, { error: 'operator_required' });
    const { tenant } = resolveTenant(req, gw);
    if (!tenant) return sendJson(res, 404, { error: 'not_found' });

    const parsed = await readJson(req);
    if (!parsed.ok) return sendJson(res, parsed.status, { error: parsed.error });
    const decision = parsed.value?.decision;
    const approvalId = parsed.value?.approvalId;
    if (decision !== 'approve' && decision !== 'deny') return sendJson(res, 400, { error: 'bad_decision' });
    if (!String(approvalId || '').trim()) return sendJson(res, 400, { error: 'approval_id_required' });

    const requestId = requestIdFrom(req.url, true);
    const proposal = proposalStore.get(requestId);
    if (!proposal || proposal.tenantId !== tenant.id) return sendJson(res, 404, { error: 'not_found' });
    if (proposal.state !== 'pending_approval') return sendJson(res, 409, { error: 'not_pending_approval', proposal: safeProposalView(proposal) });
    if (proposal.needsYouId !== approvalId) return sendJson(res, 409, { error: 'approval_correlation_mismatch' });

    const item = needsYouStore.get(approvalId);
    if (!item || item.tenantId !== tenant.id || item.status !== 'open' || !proposalMatchesNeedsYou(proposal, item)) {
      return sendJson(res, 409, { error: 'approval_correlation_invalid' });
    }

    if (decision === 'approve') {
      const currentRequest = {
        schemaVersion: 'aftergraph.tool-action-request/v1',
        requestId: proposal.requestId,
        toolId: proposal.toolId,
        capability: proposal.capability,
        toolProvenanceDigest: proposal.toolProvenanceDigest,
        principalId: proposal.principalId,
        missionId: proposal.missionId,
        executionContextId: proposal.executionContextId,
        idempotencyKey: proposal.idempotencyKey,
        argumentsDigest: proposal.argumentsDigest,
        authorityGranted: false,
        credentialMaterialPresent: false,
      };
      const current = await evaluateToolActionRequest({
        request: currentRequest,
        resolver: resolver(),
        bot: req.bot,
      });
      if (!['admitted', 'pending_approval'].includes(current.body.decision)) {
        audit('tool_action_approval_revalidation_failed', {
          by: op.name,
          requestId: proposal.requestId,
          tenantId: tenant.id,
          decision: current.body.decision,
          reasonCode: current.body.reasonCode,
        });
        return sendJson(res, 409, {
          error: 'revalidation_failed',
          admission: current.body,
          proposal: safeProposalView(proposal),
        });
      }
    }

    const decided = proposalStore.decide(proposal.requestId, decision, op.name);
    if (!decided.ok) return sendJson(res, 409, { error: decided.error, proposal: safeProposalView(decided.proposal) });

    const resolvedNeed = needsYouStore.resolve(approvalId, op.name);
    if (!resolvedNeed.ok) {
      return sendJson(res, 409, {
        error: 'needs_you_resolve_failed',
        proposal: safeProposalView(decided.proposal),
      });
    }

    audit('tool_action_proposal_resolved', {
      by: op.name,
      requestId: proposal.requestId,
      approvalId,
      tenantId: tenant.id,
      decision,
      state: decided.proposal.state,
      toolId: proposal.toolId,
      capability: proposal.capability,
    });

    return sendJson(res, 200, {
      proposal: safeProposalView(decided.proposal),
      executionReady: false,
      dispatchCreated: false,
      authorityGranted: false,
      credentialMaterialPresent: false,
    });
  });
};

module.exports.safeProposalView = safeProposalView;
module.exports.proposalMatchesNeedsYou = proposalMatchesNeedsYou;
module.exports.requestIdFrom = requestIdFrom;
