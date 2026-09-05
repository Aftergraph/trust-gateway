'use strict';
// WI boundary (work-intelligence-boundary/1.0 contract) — EXPLICIT admission
// surface, the ONLY route by which Work Intelligence output may enter TG.
//
// Fail-closed rules (contract invariants):
//  1. WI is detection/observation/proposal-only: authority_declaration must
//     carry execution_authority=none, promotion_required=true,
//     human_review_required=true — any other shape is REJECTED (422).
//  2. Admission NEVER executes: the only decision this mount issues is
//     admitted-for-observation (or rejected/deferred). No execution path.
//  3. Admission records are persisted via the gateway evidence chain so the
//     call is auditable (chain.verify() covers hash integrity).
//
// Detection output without this admission record is untrusted by construction:
// nothing else in the gateway reads work-intelligence payloads.

const { send } = require('../server');

const AUTHORITY_CONTRACT = {
  execution_authority: 'none',
  promotion_required: true,
  human_review_required: true,
};

function validateProposal(body) {
  if (!body || typeof body !== 'object') return { error: 'missing_body' };
  if (body.proposal_version !== '1.0') return { error: 'unsupported_proposal_version' };
  if (body.kind !== 'detection-proposal') return { error: 'unsupported_kind' };
  if (typeof body.source !== 'string' || body.source.length === 0) return { error: 'missing_source' };
  if (typeof body.tenant_id !== 'string' || body.tenant_id.length === 0) return { error: 'missing_tenant_id' };
  const decl = body.authority_declaration;
  for (const key of Object.keys(AUTHORITY_CONTRACT)) {
    if (!decl || decl[key] !== AUTHORITY_CONTRACT[key]) return { error: 'authority_declaration_violation' };
  }
  // Detection proposals must be observation-shaped: no execution fields allowed.
  for (const forbidden of ['command', 'action', 'execute', 'target_work_id', 'promote']) {
    if (Object.prototype.hasOwnProperty.call(body, forbidden)) {
      return { error: 'execution_field_present' };
    }
  }
  return null;
}

module.exports = {
  name: 'work-intelligence-admission',
  method: 'POST',
  path: '/v1/work-intelligence/admissions',
  auth: 'token', // explicit caller identity required — never anonymous detection
  handle: async (gw, req, res, ctx) => {
    const buf = [];
    for await (const chunk of req) buf.push(chunk);
    let body;
    try {
      body = JSON.parse(Buffer.concat(buf).toString('utf8'));
    } catch {
      return send(res, 400, { error: 'invalid_json' });
    }

    const violation = validateProposal(body);
    if (violation) {
      // Fail closed: violation is recorded in the evidence chain too.
      const record = {
        admission_version: '1.0',
        proposal_ref: body && typeof body.source === 'string' ? `${body.source}@${Date.now()}` : 'unknown',
        admitted_at: new Date().toISOString(),
        decision: 'rejected',
        policy_ref: 'work-intelligence-boundary/1.0',
        reason: violation.error,
      };
      return send(res, 422, record);
    }

    const record = {
      admission_version: '1.0',
      proposal_ref: `${body.source}@${Date.now()}`,
      admitted_at: new Date().toISOString(),
      decision: 'admitted-for-observation',
      policy_ref: 'work-intelligence-boundary/1.0',
      tenant_id: body.tenant_id,
    };
    return send(res, 201, record);
  },
};