'use strict';
// Consent Ledger — versioned consent records + permit/deny use evaluation.
//
// Pure logic: no side effects on import (repo convention per tenant-lifecycle.js).
// Consent is a separate axis from execution authority: evaluation permits or
// denies *uses*, it never grants authority (every decision carries
// authorityGranted:false and no grantAuthority export exists).
//
// Record: versioned ledger entry with append-only history (audit). Events:
// granted → restricted (narrows purpose) → revoked | expired (terminal).
// Revocation invalidates downstream effective use across all six targets
// (see DOWNSTREAM_TARGETS) while history keeps its own retention law:
// invalidation never deletes or rewrites history.

const crypto = require('node:crypto');

const SCHEMA = 'consent-ledger/0.1';

const EVENTS = ['granted', 'restricted', 'revoked', 'expired'];

// The six downstream effective-use targets revocation must invalidate.
const DOWNSTREAM_TARGETS = [
  'ingestion',
  'derived_memory',
  'context_bundle',
  'acc_projection',
  'world_state_assertion',
  'future_processing',
];

const LEDGER_ID_RE = /^led_[a-f0-9]{32}$/;
const TENANT_RE = /^ten_[a-f0-9]{32}$/;

function newLedgerId() {
  return 'led_' + crypto.randomBytes(16).toString('hex');
}

function toIso(at) {
  if (at === undefined || at === null) return new Date().toISOString();
  if (typeof at === 'number') {
    const d = new Date(at);
    return Number.isFinite(d.getTime()) ? d.toISOString() : null;
  }
  if (at instanceof Date) return Number.isFinite(at.getTime()) ? at.toISOString() : null;
  if (typeof at === 'string') {
    const ms = Date.parse(at);
    return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
  }
  return null;
}

function isNonEmptyString(v, max) {
  return typeof v === 'string' && v.length > 0 && v.length <= max;
}

/**
 * Create a version-1 granted ledger record.
 * @param {object} input {ledgerId?, subject, purpose, scopeTenant, scopeDomain, validUntil?, recordedAt?}
 * @returns {{ok:true, record}|{ok:false, error}}
 */
function createGrant(input = {}) {
  const {
    ledgerId = newLedgerId(),
    subject,
    purpose,
    scopeTenant,
    scopeDomain,
    validUntil = null,
    recordedAt,
  } = input;
  if (!LEDGER_ID_RE.test(ledgerId || '')) return { ok: false, error: 'invalid_ledger_id' };
  if (!isNonEmptyString(subject, 512)) return { ok: false, error: 'invalid_subject' };
  if (!isNonEmptyString(purpose, 256)) return { ok: false, error: 'invalid_purpose' };
  if (!TENANT_RE.test(scopeTenant || '')) return { ok: false, error: 'invalid_scope_tenant' };
  if (!isNonEmptyString(scopeDomain, 160)) return { ok: false, error: 'invalid_scope_domain' };
  const recordedIso = toIso(recordedAt === undefined ? Date.now() : recordedAt);
  if (!recordedIso) return { ok: false, error: 'invalid_recorded_at' };
  let validIso = null;
  if (validUntil !== null && validUntil !== undefined) {
    validIso = toIso(validUntil);
    if (!validIso) return { ok: false, error: 'invalid_valid_until' };
    if (Date.parse(validIso) < Date.parse(recordedIso)) {
      return { ok: false, error: 'valid_until_before_recorded' };
    }
  }
  const record = {
    schema: SCHEMA,
    ledger_id: ledgerId,
    event: 'granted',
    subject,
    purpose,
    narrowed_purpose: null,
    scope_tenant: scopeTenant,
    scope_domain: scopeDomain,
    ledger_record: `consent:${ledgerId}`,
    ledger_version: '1',
    recorded_at: recordedIso,
    valid_until: validIso,
    revoked_at: null,
    history: [{ event: 'granted', at: recordedIso, version: '1' }],
  };
  return { ok: true, record };
}

/**
 * Apply a ledger event, returning a NEW versioned record (input not mutated).
 * Terminal states (revoked/expired) accept no further events.
 * @param {object} record
 * @param {string} event granted|restricted|revoked|expired
 * @param {object} opts {at?, narrowedPurpose?}
 * @returns {{ok:true, record}|{ok:false, error}}
 */
function applyEvent(record, event, opts = {}) {
  if (!record || typeof record !== 'object') return { ok: false, error: 'invalid_record' };
  if (!EVENTS.includes(event)) return { ok: false, error: 'unknown_event' };
  if (record.event === 'revoked' || record.event === 'expired') {
    return { ok: false, error: 'terminal_state' };
  }
  if (event === 'granted') return { ok: false, error: 'already_granted' };
  const at = toIso(opts.at === undefined ? Date.now() : opts.at);
  if (!at) return { ok: false, error: 'invalid_at' };
  // Append-only order: each event must follow the last history entry, not
  // merely recorded_at, so a backdated event cannot fork history out of order.
  const hist = Array.isArray(record.history) ? record.history : [];
  const lastAt = hist.length > 0 && toIso(hist[hist.length - 1].at)
    ? hist[hist.length - 1].at
    : record.recorded_at;
  if (Date.parse(at) < Date.parse(lastAt)) {
    return { ok: false, error: 'event_before_recorded' };
  }

  const next = {
    ...record,
    history: record.history.map((h) => ({ ...h })),
  };
  if (event === 'restricted') {
    if (!isNonEmptyString(opts.narrowedPurpose, 256)) {
      return { ok: false, error: 'missing_narrowed_purpose' };
    }
    next.event = 'restricted';
    next.narrowed_purpose = opts.narrowedPurpose;
  } else if (event === 'revoked') {
    next.event = 'revoked';
    next.revoked_at = at;
  } else if (event === 'expired') {
    next.event = 'expired';
    if (!next.valid_until || Date.parse(at) < Date.parse(next.valid_until)) {
      next.valid_until = at;
    }
  }
  next.ledger_version = String(Number(record.ledger_version || '0') + 1);
  next.history.push({ event, at, version: next.ledger_version });
  return { ok: true, record: next };
}

/**
 * Permit/deny a direct use against a record. Never grants authority.
 * @param {object} record
 * @param {object} use {purpose, at?, subject?, tenant?, domain?}
 * @returns {{decision:'permit'|'deny', reason, authorityGranted:false}}
 */
function evaluateUse(record, use = {}) {
  const deny = (reason) => ({ decision: 'deny', reason, authorityGranted: false });
  if (!record || typeof record !== 'object') return deny('invalid_record');
  if (!isNonEmptyString(use.purpose, 256)) return deny('missing_use_purpose');
  const at = toIso(use.at === undefined ? Date.now() : use.at);
  if (!at) return deny('invalid_use_at');
  const atMs = Date.parse(at);

  // Principal + tenant binding (fail closed: binding must be present and match;
  // a scope-unbound use never permits).
  if (typeof use.subject !== 'string' || use.subject !== record.subject) {
    return deny('subject_mismatch');
  }
  if (typeof use.tenant !== 'string' || use.tenant !== record.scope_tenant) {
    return deny('scope_tenant_mismatch');
  }
  if (typeof use.domain !== 'string' || use.domain !== record.scope_domain) {
    return deny('scope_domain_mismatch');
  }

  // Revocation ends the purpose: uses at/after revoked_at are rejected.
  // Pre-revocation uses stay auditable as permitted-then (effective-use
  // invalidation is decided by the downstream checks, not here).
  if (record.event === 'revoked' && !record.revoked_at) return deny('revoked');
  if (record.revoked_at && atMs >= Date.parse(record.revoked_at)) {
    return deny('revoked');
  }
  // Expiry ends the purpose symmetrically; a bare expired event with no
  // valid_until fails closed.
  if (record.event === 'expired' && !record.valid_until) return deny('expired');

  // Expiry: uses past valid_until are rejected.
  if (record.valid_until && atMs > Date.parse(record.valid_until)) {
    return deny('expired');
  }

  // Purpose check: restricted records only serve the narrowed purpose.
  const allowedPurpose = record.event === 'restricted' ? record.narrowed_purpose : record.purpose;
  if (use.purpose !== allowedPurpose) {
    return deny(record.event === 'restricted' ? 'restricted_purpose_mismatch' : 'purpose_mismatch');
  }
  if (atMs < Date.parse(record.recorded_at)) return deny('use_before_recorded');

  return { decision: 'permit', reason: 'within_grant', authorityGranted: false };
}

/**
 * Rebuild the pre-terminal record for then-state evaluation: terminal markers
 * removed, expiry intact. The prior event (granted|restricted) is recovered
 * from history so a restriction narrowing survives revocation/expiry instead
 * of being flattened back to the broad granted purpose.
 */
function preTerminalRecord(record) {
  let event = record.event;
  if (event === 'revoked' || event === 'expired') {
    event = 'granted';
    if (Array.isArray(record.history)) {
      for (let i = record.history.length - 1; i >= 0; i--) {
        const e = record.history[i] && record.history[i].event;
        if (e === 'granted' || e === 'restricted') { event = e; break; }
      }
    }
  }
  return { ...record, event, revoked_at: null };
}

/**
 * True when the record was already terminal at the derivation instant, so a
 * derivation made then could not have been valid. Unknown terminal time
 * (terminal event with no timestamp) fails closed.
 */
function terminalAtDerivation(record, derivedMs) {
  if (record.revoked_at) return derivedMs >= Date.parse(record.revoked_at);
  if (record.event === 'revoked') return true;
  if (record.event === 'expired' && !record.valid_until) return true;
  if (record.event === 'expired' && record.valid_until) {
    return derivedMs > Date.parse(record.valid_until);
  }
  return false;
}

/**
 * Effective-use check for one downstream artifact derived from a record.
 * Revocation/expiry invalidates effective use even when the derivation
 * itself was valid at the time (validAtDerivation reports the then-state).
 */
function evaluateDerivedUse(record, derived = {}, opts = {}) {
  const ineffective = (reason, validAtDerivation = false) => ({
    effective: false, reason, validAtDerivation, authorityGranted: false,
  });
  if (!record || typeof record !== 'object') return ineffective('invalid_record');
  if (!DOWNSTREAM_TARGETS.includes(derived.target)) return ineffective('unknown_target');
  const derivedAt = toIso(derived.derivedAt === undefined ? Date.now() : derived.derivedAt);
  if (!derivedAt) return ineffective('invalid_derived_at');
  const at = toIso(opts.at === undefined ? Date.now() : opts.at);
  if (!at) return ineffective('invalid_at');

  // Then-state: evaluate the derivation against the true pre-terminal record
  // (purpose + binding actually verified via evaluateUse), gated on the
  // derivation predating the terminal event.
  const binding = {
    purpose: derived.purpose,
    subject: derived.subject !== undefined ? derived.subject : record.subject,
    tenant: derived.tenant !== undefined ? derived.tenant : record.scope_tenant,
    domain: derived.domain !== undefined ? derived.domain : record.scope_domain,
  };
  const thenCheck = evaluateUse(preTerminalRecord(record), { ...binding, at: derivedAt });
  const validAtDerivation = thenCheck.decision === 'permit'
    && !terminalAtDerivation(record, Date.parse(derivedAt));

  const nowCheck = evaluateUse(record, { ...binding, at });
  if (nowCheck.decision === 'deny') {
    return ineffective(`source_${nowCheck.reason}`, validAtDerivation);
  }
  if (!validAtDerivation) return ineffective('invalid_at_derivation', false);
  return { effective: true, reason: 'source_permits', validAtDerivation: true, authorityGranted: false };
}

/**
 * Context-bundle check: every constituent consent must permit at `at`.
 */
function evaluateBundle(entries = [], opts = {}) {
  const at = toIso(opts.at === undefined ? Date.now() : opts.at);
  if (!at) return { decision: 'deny', reason: 'invalid_at', authorityGranted: false };
  if (!Array.isArray(entries) || entries.length === 0) {
    return { decision: 'deny', reason: 'empty_bundle', authorityGranted: false };
  }
  const details = entries.map((e, i) => {
    const d = evaluateUse(e.record, {
      purpose: e.purpose,
      subject: e.subject !== undefined ? e.subject : e.record?.subject,
      tenant: e.tenant !== undefined ? e.tenant : e.record?.scope_tenant,
      domain: e.domain !== undefined ? e.domain : e.record?.scope_domain,
      at,
    });
    return { index: i, ...d };
  });
  const blocked = details.find((d) => d.decision === 'deny');
  if (blocked) {
    return {
      decision: 'deny', reason: `bundle_blocked:${blocked.reason}`, authorityGranted: false, details,
    };
  }
  return { decision: 'permit', reason: 'bundle_permits', authorityGranted: false, details };
}

/**
 * Invalidate a set of downstream items against a (possibly revoked) record.
 * History on the record is never touched: audit retention is distinct.
 */
function invalidateDownstream(record, items = [], opts = {}) {
  const at = toIso(opts.at === undefined ? Date.now() : opts.at) || new Date().toISOString();
  const historyLength = Array.isArray(record?.history) ? record.history.length : 0;
  const results = (Array.isArray(items) ? items : []).map((item) => {
    const r = evaluateDerivedUse(record, item, { at });
    return { target: item.target, effective: r.effective, reason: r.reason };
  });
  return {
    results,
    invalidated: results.filter((r) => !r.effective).length,
    auditPreserved: Array.isArray(record?.history) && record.history.length === historyLength,
    historyLength,
    authorityGranted: false,
  };
}

/**
 * Verify the append-only audit chain of a record.
 */
function verifyAudit(record) {
  if (!record || typeof record !== 'object') return { ok: false, error: 'invalid_record' };
  if (!Array.isArray(record.history) || record.history.length === 0) {
    return { ok: false, error: 'missing_history' };
  }
  let seenTerminal = false;
  let prevMs = -Infinity;
  for (let i = 0; i < record.history.length; i++) {
    const h = record.history[i];
    if (!EVENTS.includes(h.event)) return { ok: false, error: 'unknown_history_event' };
    if (!toIso(h.at)) return { ok: false, error: 'invalid_history_at' };
    if (String(i + 1) !== String(h.version)) return { ok: false, error: 'version_gap' };
    const ms = Date.parse(h.at);
    if (ms < prevMs) return { ok: false, error: 'non_monotonic_history' };
    prevMs = ms;
    // Legal transition order: single genesis grant, then restrictions, then at
    // most one terminal event last. Anything after terminal (or a second
    // grant) is a rewritten history, not an append.
    if (i === 0) {
      if (h.event !== 'granted') return { ok: false, error: 'genesis_not_granted' };
    } else {
      if (h.event === 'granted') return { ok: false, error: 'duplicate_grant' };
      if (seenTerminal) return { ok: false, error: 'event_after_terminal' };
    }
    if (h.event === 'revoked' || h.event === 'expired') seenTerminal = true;
  }
  if (String(record.history.length) !== String(record.ledger_version)) {
    return { ok: false, error: 'version_mismatch' };
  }
  if (record.history[0].event !== 'granted') return { ok: false, error: 'genesis_not_granted' };
  const last = record.history[record.history.length - 1];
  if (last.event !== record.event) return { ok: false, error: 'head_event_mismatch' };
  return { ok: true, versions: record.history.length };
}

module.exports = {
  SCHEMA,
  EVENTS,
  DOWNSTREAM_TARGETS,
  createGrant,
  applyEvent,
  evaluateUse,
  evaluateDerivedUse,
  evaluateBundle,
  invalidateDownstream,
  verifyAudit,
};
