'use strict';

const crypto = require('node:crypto');
const dbmod = require('./db');

const ID = {
  action: /^act_[a-f0-9]{32}$/u,
  tenant: /^ten_[a-f0-9]{32}$/u,
  principal: /^prn_[a-f0-9]{32}$/u,
  authority: /^auth_[a-f0-9]{32}$/u,
  context: /^ctx_[a-f0-9]{32}$/u,
};

function newPdrId() {
  return `pdr_${crypto.randomBytes(16).toString('hex')}`;
}

function validate(input) {
  if (!input || typeof input !== 'object') throw new Error('pdr_input_required');
  if (!ID.action.test(input.action_id || '')) throw new Error('invalid_action_id');
  if (input.phase !== 'execution') throw new Error('invalid_pdr_phase');
  if (!ID.tenant.test(input.tenant_id || '')) throw new Error('invalid_tenant_id');
  if (!ID.principal.test(input.principal_id || '')) throw new Error('invalid_principal_id');
  if (typeof input.mission_id !== 'string' || input.mission_id.length === 0) throw new Error('invalid_mission_id');
  if (!ID.authority.test(input.authority_lease_id || '')) throw new Error('invalid_authority_lease_id');
  if (!ID.context.test(input.execution_context_id || '')) throw new Error('invalid_execution_context_id');
  if (input.allow !== true && input.allow !== false) throw new Error('invalid_allow');
  if (typeof input.reason !== 'string' || input.reason.length === 0) throw new Error('invalid_reason');
}

function createExecutionDecision(input, now = () => new Date().toISOString()) {
  validate(input);
  return dbmod.tx(() => {
    const existing = dbmod.db.prepare(`
      SELECT id, action_id, phase, tenant_id, principal_id, mission_id,
             authority_lease_id, execution_context_id, allow, reason, decided_at
      FROM platform_policy_decisions
      WHERE action_id = ? AND phase = 'execution'
    `).get(input.action_id);
    if (existing) {
      const same = existing.tenant_id === input.tenant_id &&
        existing.principal_id === input.principal_id &&
        existing.mission_id === input.mission_id &&
        existing.authority_lease_id === input.authority_lease_id &&
        existing.execution_context_id === input.execution_context_id &&
        Boolean(existing.allow) === input.allow &&
        existing.reason === input.reason;
      if (!same) throw new Error('execution_pdr_conflict');
      return { ...existing, allow: Boolean(existing.allow) };
    }

    const record = {
      id: newPdrId(),
      action_id: input.action_id,
      phase: 'execution',
      tenant_id: input.tenant_id,
      principal_id: input.principal_id,
      mission_id: input.mission_id,
      authority_lease_id: input.authority_lease_id,
      execution_context_id: input.execution_context_id,
      allow: input.allow,
      reason: input.reason,
      decided_at: now(),
    };
    dbmod.db.prepare(`
      INSERT INTO platform_policy_decisions
        (id, action_id, phase, tenant_id, principal_id, mission_id,
         authority_lease_id, execution_context_id, allow, reason, decided_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      record.id, record.action_id, record.phase, record.tenant_id,
      record.principal_id, record.mission_id, record.authority_lease_id,
      record.execution_context_id, record.allow ? 1 : 0, record.reason,
      record.decided_at,
    );
    return record;
  });
}

function getExecutionDecision(actionId) {
  const row = dbmod.db.prepare(`
    SELECT id, action_id, phase, tenant_id, principal_id, mission_id,
           authority_lease_id, execution_context_id, allow, reason, decided_at
    FROM platform_policy_decisions
    WHERE action_id = ? AND phase = 'execution'
  `).get(actionId);
  return row ? { ...row, allow: Boolean(row.allow) } : null;
}

module.exports = { createExecutionDecision, getExecutionDecision, validate };
