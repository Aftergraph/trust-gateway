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
  const entry = { event, at, version: next.ledger_version };
  // Record the narrowing on the entry itself so the purpose in force at any
  // past instant can be reconstructed (restriction applies prospectively).
  if (event === 'restricted') entry.narrowedPurpose = opts.narrowedPurpose;
  next.history.push(entry);
  return { ok: true, record: next };
}

/**
 * Purpose state applicable at an instant, reconstructed from history: a
 * restriction narrows the purpose prospectively from its own timestamp, so a
 * pre-restriction use is still evaluated under the granted purpose.
 * Histories that predate per-entry narrowedPurpose values fall back to the
 * record's current narrowed_purpose once a restriction applies.
 */
function purposeStateAt(record, atMs) {
  const hist = Array.isArray(record.history) ? record.history : null;
  if (!hist || hist.length === 0) {
    const restricted = record.event === 'restricted';
    return { allowed: restricted ? record.narrowed_purpose : record.purpose, restricted };
  }
  let narrowed = null;
  let applies = false;
  for (const h of hist) {
    if (!h || h.event !== 'restricted') continue;
    const ms = Date.parse(h.at);
    if (!Number.isFinite(ms) || ms > atMs) continue;
    applies = true;
    narrowed = (typeof h.narrowedPurpose === 'string' && h.narrowedPurpose.length > 0)
      ? h.narrowedPurpose
      : record.narrowed_purpose;
  }
  if (!applies) return { allowed: record.purpose, restricted: false };
  return { allowed: narrowed, restricted: true };
}

/**
 * Fail-closed terminal cutoff for one terminal event: the history entry is
 * authoritative, so a tampered top-level marker moved later cannot reopen an
 * interim window. The earliest timestamp wins (either marker denies).
 */
function terminalCutoffMs(record, event) {
  const field = event === 'revoked' ? record.revoked_at : record.valid_until;
  let cutoff = null;
  if (typeof field === 'string') {
    const ms = Date.parse(field);
    if (Number.isFinite(ms)) cutoff = ms;
  }
  if (Array.isArray(record.history)) {
    for (const h of record.history) {
      if (!h || h.event !== event || typeof h.at !== 'string') continue;
      const ms = Date.parse(h.at);
      if (Number.isFinite(ms)) cutoff = cutoff === null ? ms : Math.min(cutoff, ms);
    }
  }
  return cutoff;
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

  // Revocation ends the purpose: uses at/after the cutoff are rejected.
  // The cutoff is history-authoritative (earliest of revoked_at and the
  // revocation history entry), so a tampered revoked_at moved later cannot
  // reopen an interim window. Pre-revocation uses stay auditable as
  // permitted-then (effective-use invalidation is decided downstream).
  const revokeMs = terminalCutoffMs(record, 'revoked');
  if (record.event === 'revoked' && revokeMs === null) return deny('revoked');
  if (revokeMs !== null && atMs >= revokeMs) {
    return deny('revoked');
  }
  // Expiry ends the purpose symmetrically; a bare expired event with no
  // valid_until fails closed.
  const expiryMs = terminalCutoffMs(record, 'expired');
  if (record.event === 'expired' && expiryMs === null) return deny('expired');

  // Expiry: uses past the cutoff are rejected.
  if (expiryMs !== null && atMs > expiryMs) {
    return deny('expired');
  }

  // Purpose check: a restriction in force at the use instant narrows the
  // allowed purpose; earlier uses keep the granted purpose.
  const state = purposeStateAt(record, atMs);
  if (use.purpose !== state.allowed) {
    return deny(state.restricted ? 'restricted_purpose_mismatch' : 'purpose_mismatch');
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
  const revokeMs = terminalCutoffMs(record, 'revoked');
  if (revokeMs !== null) return derivedMs >= revokeMs;
  if (record.event === 'revoked') return true;
  if (record.event === 'expired') {
    const expiryMs = terminalCutoffMs(record, 'expired');
    if (expiryMs === null) return true;
    return derivedMs > expiryMs;
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

  // Binding is fail closed: a derived entry must carry its own
  // subject/tenant/domain — nothing is defaulted from the record, so an
  // unbound entry can never manufacture a match.
  if (derived.subject === undefined || derived.tenant === undefined || derived.domain === undefined) {
    return ineffective('missing_binding', false);
  }
  // Then-state: evaluate the derivation against the true pre-terminal record
  // (purpose + binding actually verified via evaluateUse), gated on the
  // derivation predating the terminal event.
  const binding = {
    purpose: derived.purpose,
    subject: derived.subject,
    tenant: derived.tenant,
    domain: derived.domain,
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
    // Fail closed like evaluateDerivedUse: bundle entries must carry their
    // own bindings; nothing is defaulted from the record.
    if (!e || e.subject === undefined || e.tenant === undefined || e.domain === undefined) {
      return {
        index: i, decision: 'deny', reason: 'missing_binding', authorityGranted: false,
      };
    }
    const d = evaluateUse(e.record, {
      purpose: e.purpose,
      subject: e.subject,
      tenant: e.tenant,
      domain: e.domain,
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
  // Terminal-marker binding (checked after the chain walk so existing
  // monotonicity/terminal-order errors keep their precedence): top-level
  // markers must equal the terminal history entry, so a tampered
  // revoked_at/valid_until cannot pass audit.
  if (record.event === 'revoked') {
    if (typeof record.revoked_at !== 'string' || !toIso(record.revoked_at)) {
      return { ok: false, error: 'revoked_at_missing' };
    }
    const revEntry = record.history.filter((h) => h.event === 'revoked').pop();
    if (!revEntry) return { ok: false, error: 'revoked_at_without_history' };
    if (Date.parse(record.revoked_at) !== Date.parse(revEntry.at)) {
      return { ok: false, error: 'revoked_at_mismatch' };
    }
  } else if (record.revoked_at !== null && record.revoked_at !== undefined) {
    return { ok: false, error: 'revoked_at_without_revocation' };
  }
  if (record.event === 'expired') {
    if (typeof record.valid_until !== 'string' || !toIso(record.valid_until)) {
      return { ok: false, error: 'valid_until_missing' };
    }
    const expEntry = record.history.filter((h) => h.event === 'expired').pop();
    if (!expEntry) return { ok: false, error: 'expired_without_history' };
    if (Date.parse(record.valid_until) > Date.parse(expEntry.at)) {
      return { ok: false, error: 'valid_until_mismatch' };
    }
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
