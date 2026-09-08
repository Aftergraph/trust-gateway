'use strict';

// Experimental Aftergraph Platform Fabrics v0.1 adapter.
//
// Projects a native Trust Gateway sealed audit entry into the shared
// correlation-only `platform-event-ref/0.1` shape. The projection never
// replaces the native hash-chain entry and never carries or grants authority.

const crypto = require('node:crypto');
const { entryHash } = require('./hash-chain');

const HEX64 = /^[a-f0-9]{64}$/u;
const IDS = {
  tenant_id: /^ten_[a-f0-9]{32}$/u,
  principal_id: /^prn_[a-f0-9]{32}$/u,
  execution_context_id: /^ctx_[a-f0-9]{32}$/u,
  authority_lease_id: /^auth_[a-f0-9]{32}$/u,
  work_id: /^wrk_[a-f0-9]{32}$/u,
  admission_decision_id: /^pdr_[a-f0-9]{32}$/u,
  trace_id: /^trc_[a-f0-9]{32}$/u,
  action_id: /^act_[a-f0-9]{32}$/u,
};

const REQUIRED_CORRELATION = ['tenant_id', 'mission_id', 'trace_id', 'action_id'];
const OPTIONAL_CORRELATION = [
  'execution_context_id',
  'principal_id',
  'authority_lease_id',
  'work_id',
  'admission_decision_id',
];

function _nonEmpty(value, max = 512) {
  return typeof value === 'string' && value.length > 0 && value.length <= max;
}

function _assertCorrelation(correlation) {
  if (!correlation || typeof correlation !== 'object' || Array.isArray(correlation)) {
    throw new TypeError('platform event correlation must be an object');
  }

  for (const field of REQUIRED_CORRELATION) {
    if (!(field in correlation)) throw new TypeError(`missing correlation field: ${field}`);
  }
  for (const field of [...REQUIRED_CORRELATION, ...OPTIONAL_CORRELATION]) {
    if (!(field in correlation)) continue;
    const value = correlation[field];
    if (field === 'mission_id') {
      if (!_nonEmpty(value, 256)) throw new TypeError('invalid mission_id');
      continue;
    }
    const pattern = IDS[field];
    if (!pattern || typeof value !== 'string' || !pattern.test(value)) {
      throw new TypeError(`invalid ${field}`);
    }
  }

  const allowed = new Set([...REQUIRED_CORRELATION, ...OPTIONAL_CORRELATION]);
  for (const field of Object.keys(correlation)) {
    if (!allowed.has(field)) throw new TypeError(`unexpected correlation field: ${field}`);
  }
}

function _assertNativeEntry(entry) {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
    throw new TypeError('native audit entry must be an object');
  }
  if (!Number.isSafeInteger(entry.seq) || entry.seq < 0) throw new TypeError('invalid audit seq');
  if (!Number.isSafeInteger(entry.ts) || entry.ts < 0) throw new TypeError('invalid audit ts');
  if (typeof entry.prevHash !== 'string' || !HEX64.test(entry.prevHash)) {
    throw new TypeError('invalid audit prevHash');
  }
  if (typeof entry.hash !== 'string' || !HEX64.test(entry.hash)) throw new TypeError('invalid audit hash');
  if (!entry.payload || typeof entry.payload !== 'object' || Array.isArray(entry.payload)) {
    throw new TypeError('invalid audit payload');
  }
  if (!_nonEmpty(entry.payload.type, 160)) throw new TypeError('audit payload missing type');

  const expectedHash = entryHash(entry.seq, entry.prevHash, entry.ts, entry.payload);
  if (expectedHash !== entry.hash) throw new Error('native audit hash mismatch');
}

function _eventId(entry) {
  const digest = crypto
    .createHash('sha256')
    .update(`trust-gateway\0${entry.seq}\0${entry.hash}`, 'utf8')
    .digest('hex');
  return `evt_${digest.slice(0, 32)}`;
}

function projectPlatformEventRef(entry, { subjectRef, correlation, tenantBinding } = {}) {
  _assertNativeEntry(entry);
  _assertCorrelation(correlation);
  if (!_nonEmpty(subjectRef, 256)) throw new TypeError('invalid subjectRef');
  if (!tenantBinding || typeof tenantBinding !== 'object' || Array.isArray(tenantBinding)) {
    throw new TypeError('tenant binding is required');
  }
  if (!_nonEmpty(tenantBinding.local_tenant_id, 160)) {
    throw new TypeError('invalid tenant binding local_tenant_id');
  }
  if (typeof tenantBinding.tenant_id !== 'string' || !IDS.tenant_id.test(tenantBinding.tenant_id)) {
    throw new TypeError('invalid tenant binding tenant_id');
  }
  if (correlation.tenant_id !== tenantBinding.tenant_id) {
    throw new Error('canonical tenant does not match tenant binding');
  }

  // Native entries carry the LOCAL tenant id; entries without an explicit
  // tenant belong to the main tenant row. The durable binding is the only
  // local-to-canonical authority - never compare a local id to canonical.
  const nativeTenant = entry.payload.tenant === undefined ? 'main' : entry.payload.tenant;
  if (nativeTenant !== tenantBinding.local_tenant_id) {
    throw new Error('native audit tenant does not match tenant binding');
  }

  const projectedCorrelation = {};
  for (const field of [...REQUIRED_CORRELATION, ...OPTIONAL_CORRELATION]) {
    if (correlation[field] !== undefined) projectedCorrelation[field] = correlation[field];
  }

  return Object.freeze({
    schema: 'platform-event-ref/0.1',
    event_id: _eventId(entry),
    source: 'trust-gateway',
    event_type: entry.payload.type,
    occurred_at: new Date(entry.ts).toISOString(),
    subject_ref: subjectRef,
    correlation: Object.freeze(projectedCorrelation),
    payload_ref: `tg:audit:${entry.seq}`,
    integrity_ref: `sha256:${entry.hash}`,
    classification: 'enforcement',
  });
}

module.exports = {
  projectPlatformEventRef,
};
