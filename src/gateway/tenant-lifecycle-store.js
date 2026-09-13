'use strict';
// TG85 — tenant lifecycle record store (D-2026-09-10-01).
//
// KV-backed persistence for tenant-lifecycle/0.1 records. Fail-closed:
// missing or malformed records read as null, never synthesized; owners
// are operator-supplied, never invented.

const { KV } = require('./kvstore');
const lifecycle = require('./tenant-lifecycle');

const SCHEMA = 'tenant-lifecycle/0.1';
const ACK_KINDS = ['export', 'deletion', 'retention'];

function keyFor(tenantId) {
  return `tenant:lifecycle:${tenantId}`;
}

function nowIso() {
  return new Date().toISOString();
}

function validOwners(v) {
  return Array.isArray(v) && v.length > 0
    && v.every((o) => typeof o === 'string' && o.length > 0);
}

function load(tenantId) {
  if (!tenantId) return null;
  try {
    const kv = new KV();
    const raw = kv.get(keyFor(tenantId));
    if (!raw) return null;
    const rec = JSON.parse(raw);
    if (!rec || rec.schema !== SCHEMA) return null;
    return rec;
  } catch { return null; }
}

function save(record) {
  const kv = new KV();
  kv.set(keyFor(record.tenant_id), JSON.stringify(record));
  return record;
}

function getRecord(tenantId) {
  return load(tenantId);
}

function createRecord(tenantId, { requiredOwners, actor } = {}) {
  if (!tenantId) return { ok: false, error: 'missing_tenant' };
  if (!validOwners(requiredOwners)) return { ok: false, error: 'invalid_owners' };
  if (load(tenantId)) return { ok: false, error: 'record_exists' };
  const at = nowIso();
  const record = {
    schema: SCHEMA,
    lifecycle_id: `lc_${tenantId}_${Date.now().toString(36)}`,
    tenant_id: tenantId,
    state: 'active',
    previous_state: null,
    recorded_at: at,
    attempted_action: { kind: 'none', at },
    required_owners: [...requiredOwners],
    owner_acknowledgements: [],
    opened_by: actor || 'unknown',
  };
  return { ok: true, record: save(record) };
}

function recordAck(tenantId, { owner, ack } = {}) {
  const rec = load(tenantId);
  if (!rec) return { ok: false, error: 'missing_record' };
  if (!ACK_KINDS.includes(ack)) return { ok: false, error: 'invalid_ack_kind' };
  if (!rec.required_owners.includes(owner)) return { ok: false, error: 'unknown_owner' };
  rec.owner_acknowledgements.push({ owner, ack, at: nowIso() });
  return { ok: true, record: save(rec) };
}

function applyTransition(tenantId, toState, actor) {
  const rec = load(tenantId);
  if (!rec) return { ok: false, error: 'missing_record' };
  const decision = lifecycle.canTransitionTenant(rec, toState);
  if (!decision.allowed) return { ok: false, reason: decision.reason };
  const next = {
    ...rec,
    previous_state: rec.state,
    state: toState,
    recorded_at: nowIso(),
    attempted_action: { kind: 'none', at: nowIso() },
    last_transition_by: actor || 'unknown',
    last_transition_reason: decision.reason,
  };
  return { ok: true, record: save(next) };
}

module.exports = { getRecord, createRecord, recordAck, applyTransition, SCHEMA, ACK_KINDS };
