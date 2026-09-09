'use strict';
// Consent Ledger — acceptance + conformance tests.
//
// Covers request trust-gateway-consent-ledger:
//   CON-001 (grant accept), CON-002 (post-revocation reject),
//   CON-003 (post-expiry reject), CON-004 (restricted-purpose reject),
//   CONS-REV-001 (revocation invalidates derived uses, audit preserved),
//   CONS-REV-002 (ingestion denied, bundles invalidated, future processing blocked).
// Security: authority widening, stale-evidence acceptance, wrong principal
// binding, revocation bypass, cross-tenant leakage, audit rewrite.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const {
  SCHEMA,
  DOWNSTREAM_TARGETS,
  createGrant,
  applyEvent,
  evaluateUse,
  evaluateDerivedUse,
  evaluateBundle,
  invalidateDownstream,
  verifyAudit,
} = require('../src/gateway/consent-ledger');

const LEDGER_ID = 'led_' + 'a1'.repeat(16);
const TENANT = 'ten_' + 'b2'.repeat(16);
const OTHER_TENANT = 'ten_' + 'c3'.repeat(16);
const SUBJECT = 'user:alice';
const PURPOSE = 'support-debug';
const DOMAIN = 'support.example.com';

const T0 = '2026-01-01T00:00:00.000Z'; // recorded_at
const T_REVOKE = '2026-03-01T00:00:00.000Z'; // revoked_at
const T_USE = '2026-06-01T00:00:00.000Z'; // in-validity use (but post-revocation)
const T_HISTORICAL = '2026-02-01T00:00:00.000Z'; // pre-revocation use
const T_VALID_UNTIL = '2027-01-01T00:00:00.000Z';
const T_EXPIRED = '2028-01-01T00:00:00.000Z'; // past valid_until

function grant(over = {}) {
  const r = createGrant({
    ledgerId: LEDGER_ID,
    subject: SUBJECT,
    purpose: PURPOSE,
    scopeTenant: TENANT,
    scopeDomain: DOMAIN,
    recordedAt: T0,
    validUntil: T_VALID_UNTIL,
    ...over,
  });
  assert.equal(r.ok, true, `setup grant failed: ${r.error}`);
  return r.record;
}

function revokedRecord() {
  const r = applyEvent(grant(), 'revoked', { at: T_REVOKE });
  assert.equal(r.ok, true, `setup revoke failed: ${r.error}`);
  return r.record;
}

describe('consent-ledger CON acceptance', () => {
  it('CON-001: use within granted purpose, scope, and validity is accepted', () => {
    const d = evaluateUse(grant(), {
      purpose: PURPOSE, subject: SUBJECT, tenant: TENANT, domain: DOMAIN, at: T_HISTORICAL,
    });
    assert.equal(d.decision, 'permit');
    assert.equal(d.authorityGranted, false);
  });

  it('CON-002: use where revocation ended the purpose is rejected', () => {
    const d = evaluateUse(revokedRecord(), {
      purpose: PURPOSE, subject: SUBJECT, tenant: TENANT, domain: DOMAIN, at: T_USE,
    });
    assert.equal(d.decision, 'deny');
    assert.match(d.reason, /revok/);
    assert.equal(d.authorityGranted, false);
  });

  it('CON-003: use past expiry is rejected', () => {
    const d = evaluateUse(grant(), {
      purpose: PURPOSE, subject: SUBJECT, tenant: TENANT, domain: DOMAIN, at: T_EXPIRED,
    });
    assert.equal(d.decision, 'deny');
    assert.match(d.reason, /expir/);
  });

  it('CON-003b: explicit expired event denies post-expiry uses', () => {
    const r = applyEvent(grant(), 'expired', { at: T_VALID_UNTIL });
    assert.equal(r.ok, true);
    const d = evaluateUse(r.record, {
      purpose: PURPOSE, subject: SUBJECT, tenant: TENANT, domain: DOMAIN, at: T_EXPIRED,
    });
    assert.equal(d.decision, 'deny');
    assert.match(d.reason, /expir/);
  });

  it('CON-004: use outside a narrowed restricted purpose is rejected', () => {
    const r = applyEvent(grant(), 'restricted', { at: T0, narrowedPurpose: 'billing-only' });
    assert.equal(r.ok, true);
    const denied = evaluateUse(r.record, {
      purpose: PURPOSE, subject: SUBJECT, tenant: TENANT, domain: DOMAIN, at: T_HISTORICAL,
    });
    assert.equal(denied.decision, 'deny');
    assert.match(denied.reason, /restrict|purpose/);
    const allowed = evaluateUse(r.record, {
      purpose: 'billing-only', subject: SUBJECT, tenant: TENANT, domain: DOMAIN, at: T_HISTORICAL,
    });
    assert.equal(allowed.decision, 'permit');
  });
});

describe('consent-ledger CONS-REV conformance', () => {
  it('CONS-REV-001: revoked source invalidates derived uses, audit preserved', () => {
    const g = grant();
    const before = evaluateDerivedUse(g, {
      target: 'derived_memory', purpose: PURPOSE, subject: SUBJECT, tenant: TENANT,
      domain: DOMAIN, derivedAt: T_HISTORICAL,
    }, { at: T_HISTORICAL });
    assert.equal(before.effective, true);

    const rev = revokedRecord();
    for (const target of DOWNSTREAM_TARGETS) {
      const d = evaluateDerivedUse(rev, {
        target, purpose: PURPOSE, subject: SUBJECT, tenant: TENANT,
        domain: DOMAIN, derivedAt: T_HISTORICAL,
      }, { at: T_USE });
      assert.equal(d.effective, false, `target ${target} still effective after revocation`);
    }
    // Audit retention distinct: history survives revocation, chain verifies.
    assert.ok(rev.history.length >= g.history.length);
    assert.equal(verifyAudit(rev).ok, true);
    assert.equal(verifyAudit(g).ok, true);
  });

  it('CONS-REV-001b: invalidateDownstream marks every item ineffective, keeps audit', () => {
    const rev = revokedRecord();
    const items = DOWNSTREAM_TARGETS.map((target) => ({
      target, purpose: PURPOSE, subject: SUBJECT, tenant: TENANT,
      domain: DOMAIN, derivedAt: T_HISTORICAL,
    }));
    const out = invalidateDownstream(rev, items, { at: T_USE });
    assert.equal(out.results.length, DOWNSTREAM_TARGETS.length);
    for (const r of out.results) assert.equal(r.effective, false);
    assert.equal(out.auditPreserved, true);
    assert.equal(verifyAudit(rev).ok, true);
  });

  it('CONS-REV-002: ingestion denied, bundles invalidated, future processing blocked', () => {
    const rev = revokedRecord();
    const ingestion = evaluateDerivedUse(rev, {
      target: 'ingestion', purpose: PURPOSE, subject: SUBJECT, tenant: TENANT,
      domain: DOMAIN, derivedAt: T_USE,
    }, { at: T_USE });
    assert.equal(ingestion.effective, false);

    const bundle = evaluateBundle([
      { record: grant(), purpose: PURPOSE, subject: SUBJECT, tenant: TENANT, domain: DOMAIN },
      { record: rev, purpose: PURPOSE, subject: SUBJECT, tenant: TENANT, domain: DOMAIN },
    ], { at: T_USE });
    assert.equal(bundle.decision, 'deny');

    const future = evaluateUse(rev, {
      purpose: PURPOSE, subject: SUBJECT, tenant: TENANT, domain: DOMAIN, at: T_EXPIRED,
    });
    assert.equal(future.decision, 'deny');

    const futureDerived = evaluateDerivedUse(rev, {
      target: 'future_processing', purpose: PURPOSE, subject: SUBJECT, tenant: TENANT,
      domain: DOMAIN, derivedAt: T_USE,
    }, { at: T_USE });
    assert.equal(futureDerived.effective, false);
  });
});

describe('consent-ledger security self-check', () => {
  it('consent never grants authority on any path', () => {
    const g = grant();
    const rev = revokedRecord();
    const decisions = [
      evaluateUse(g, { purpose: PURPOSE, at: T_HISTORICAL }),
      evaluateDerivedUse(g, { target: 'ingestion', purpose: PURPOSE, derivedAt: T_HISTORICAL }, { at: T_HISTORICAL }),
      evaluateBundle([{ record: g, purpose: PURPOSE }], { at: T_HISTORICAL }),
    ];
    for (const d of decisions) {
      assert.equal(d.authorityGranted, false);
      assert.ok(!('authority' in d) || d.authority === undefined);
    }
    assert.equal(typeof require('../src/gateway/consent-ledger').grantAuthority, 'undefined');
    void rev;
  });

  it('wrong principal binding is denied', () => {
    const d = evaluateUse(grant(), {
      purpose: PURPOSE, subject: 'user:mallory', tenant: TENANT, domain: DOMAIN, at: T_HISTORICAL,
    });
    assert.equal(d.decision, 'deny');
    assert.match(d.reason, /subject|principal/);
  });

  it('cross-tenant use is denied', () => {
    const d = evaluateUse(grant(), {
      purpose: PURPOSE, subject: SUBJECT, tenant: OTHER_TENANT, domain: DOMAIN, at: T_HISTORICAL,
    });
    assert.equal(d.decision, 'deny');
    assert.match(d.reason, /tenant/);
    const derived = evaluateDerivedUse(grant(), {
      target: 'context_bundle', purpose: PURPOSE, subject: SUBJECT, tenant: OTHER_TENANT,
      domain: DOMAIN, derivedAt: T_HISTORICAL,
    }, { at: T_HISTORICAL });
    assert.equal(derived.effective, false);
  });

  it('stale evidence (expired record, mismatched purpose) is denied', () => {
    const d = evaluateUse(grant(), {
      purpose: 'other-purpose', subject: SUBJECT, tenant: TENANT, domain: DOMAIN, at: T_HISTORICAL,
    });
    assert.equal(d.decision, 'deny');
  });

  it('revocation cannot be bypassed via pre-revocation use_at after revocation event', () => {
    const rev = revokedRecord();
    // Historical use (before revoked_at) stays auditable as permitted-then ...
    const historical = evaluateUse(rev, {
      purpose: PURPOSE, subject: SUBJECT, tenant: TENANT, domain: DOMAIN, at: T_HISTORICAL,
    });
    assert.equal(historical.decision, 'permit');
    // ... but effective downstream use after revocation is invalid.
    const eff = evaluateDerivedUse(rev, {
      target: 'derived_memory', purpose: PURPOSE, subject: SUBJECT, tenant: TENANT,
      domain: DOMAIN, derivedAt: T_HISTORICAL,
    }, { at: T_USE });
    assert.equal(eff.effective, false);
    assert.equal(eff.validAtDerivation, true);
  });

  it('audit history is append-only across events (no rewrite)', () => {
    const g = grant();
    const r1 = applyEvent(g, 'restricted', { at: T0, narrowedPurpose: 'billing-only' });
    const r2 = applyEvent(r1.record, 'revoked', { at: T_REVOKE });
    assert.equal(r2.ok, true);
    assert.equal(r2.record.history.length, 3);
    assert.deepEqual(r2.record.history.map((h) => h.event), ['granted', 'restricted', 'revoked']);
    assert.equal(g.history.length, 1); // input not mutated
    assert.equal(verifyAudit(r2.record).ok, true);
  });
});

describe('consent-ledger record hygiene', () => {
  it('createGrant validates required fields', () => {
    assert.equal(createGrant({}).ok, false);
    assert.equal(createGrant({ subject: SUBJECT }).ok, false);
    const badTenant = createGrant({
      subject: SUBJECT, purpose: PURPOSE, scopeTenant: 'nope', scopeDomain: DOMAIN,
    });
    assert.equal(badTenant.ok, false);
  });

  it('events bump ledger_version without mutating the input', () => {
    const g = grant();
    const r = applyEvent(g, 'restricted', { at: T0, narrowedPurpose: 'billing-only' });
    assert.equal(r.ok, true);
    assert.notEqual(r.record.ledger_version, g.ledger_version);
    assert.equal(g.event, 'granted');
    assert.equal(g.history.length, 1);
  });

  it('invalid transitions are rejected', () => {
    assert.equal(applyEvent(grant(), 'restricted', { at: T0 }).ok, false); // narrowed purpose required
    assert.equal(applyEvent(revokedRecord(), 'granted', { at: T_USE }).ok, false); // no un-revoke
    assert.equal(applyEvent(grant(), 'bogus', { at: T0 }).ok, false);
  });

  it('record carries the contract schema id', () => {
    assert.equal(grant().schema, SCHEMA);
    assert.equal(SCHEMA, 'consent-ledger/0.1');
  });
});

describe('consent-ledger SOB fixes (fail-closed TDD)', () => {
  const T_RESTRICT = '2026-02-01T00:00:00.000Z';
  const T_DERIVED = '2026-02-15T00:00:00.000Z'; // post-restriction, pre-revocation

  function restrictedRevokedRecord() {
    const r1 = applyEvent(grant(), 'restricted', { at: T_RESTRICT, narrowedPurpose: 'billing-only' });
    assert.equal(r1.ok, true, `setup restrict failed: ${r1.error}`);
    const r2 = applyEvent(r1.record, 'revoked', { at: T_REVOKE });
    assert.equal(r2.ok, true, `setup revoke failed: ${r2.error}`);
    return r2.record;
  }

  it('SOB-01: scope-unbound use is denied (missing subject/tenant/domain)', () => {
    const noSubject = evaluateUse(grant(), {
      purpose: PURPOSE, tenant: TENANT, domain: DOMAIN, at: T_HISTORICAL,
    });
    assert.equal(noSubject.decision, 'deny');
    assert.match(noSubject.reason, /subject/);
    const noTenant = evaluateUse(grant(), {
      purpose: PURPOSE, subject: SUBJECT, domain: DOMAIN, at: T_HISTORICAL,
    });
    assert.equal(noTenant.decision, 'deny');
    assert.match(noTenant.reason, /tenant/);
    const noDomain = evaluateUse(grant(), {
      purpose: PURPOSE, subject: SUBJECT, tenant: TENANT, at: T_HISTORICAL,
    });
    assert.equal(noDomain.decision, 'deny');
    assert.match(noDomain.reason, /domain/);
    const explicitUndefined = evaluateUse(grant(), {
      purpose: PURPOSE, subject: undefined, tenant: undefined, domain: undefined, at: T_HISTORICAL,
    });
    assert.equal(explicitUndefined.decision, 'deny');
  });

  it('SOB-02: expired derivation verifies purpose at derivation (no blind validAtDerivation)', () => {
    const r = applyEvent(grant(), 'expired', { at: T_VALID_UNTIL });
    assert.equal(r.ok, true);
    const wrongPurpose = evaluateDerivedUse(r.record, {
      target: 'derived_memory', purpose: 'other-purpose', subject: SUBJECT, tenant: TENANT,
      domain: DOMAIN, derivedAt: T_HISTORICAL,
    }, { at: T_HISTORICAL });
    assert.equal(wrongPurpose.validAtDerivation, false);
    const rightPurpose = evaluateDerivedUse(r.record, {
      target: 'derived_memory', purpose: PURPOSE, subject: SUBJECT, tenant: TENANT,
      domain: DOMAIN, derivedAt: T_HISTORICAL,
    }, { at: T_HISTORICAL });
    assert.equal(rightPurpose.validAtDerivation, true);
  });

  it('SOB-02b: revoked-then-state keeps restriction narrowing (broad purpose invalid at derivation)', () => {
    const rev = restrictedRevokedRecord();
    const broad = evaluateDerivedUse(rev, {
      target: 'derived_memory', purpose: PURPOSE, subject: SUBJECT, tenant: TENANT,
      domain: DOMAIN, derivedAt: T_DERIVED,
    }, { at: T_USE });
    assert.equal(broad.effective, false);
    assert.equal(broad.validAtDerivation, false);
    const narrow = evaluateDerivedUse(rev, {
      target: 'derived_memory', purpose: 'billing-only', subject: SUBJECT, tenant: TENANT,
      domain: DOMAIN, derivedAt: T_DERIVED,
    }, { at: T_USE });
    assert.equal(narrow.effective, false); // post-revocation now-state still invalid
    assert.equal(narrow.validAtDerivation, true); // ... but it was permitted-then
  });

  it('SOB-03: backdated event after later history is rejected; audit enforces monotonicity', () => {
    const r1 = applyEvent(grant(), 'restricted', { at: T_USE, narrowedPurpose: 'billing-only' });
    assert.equal(r1.ok, true);
    const backdated = applyEvent(r1.record, 'revoked', { at: T_HISTORICAL });
    assert.equal(backdated.ok, false);
    // Hand-shuffled history (transition-legal, timestamps decreasing) must not verify.
    const tampered = JSON.parse(JSON.stringify(r1.record));
    tampered.event = 'revoked';
    tampered.revoked_at = T_HISTORICAL;
    tampered.ledger_version = '3';
    tampered.history.push({ event: 'revoked', at: T_HISTORICAL, version: '3' });
    assert.equal(verifyAudit(tampered).ok, false);
    assert.match(verifyAudit(tampered).error, /monotonic/);
  });

  it('SOB-04: audit rejects events after a terminal state', () => {
    const forged = JSON.parse(JSON.stringify(revokedRecord()));
    forged.event = 'restricted';
    forged.narrowed_purpose = 'billing-only';
    forged.ledger_version = '3';
    forged.history.push({ event: 'restricted', at: T_USE, version: '3' });
    const v = verifyAudit(forged);
    assert.equal(v.ok, false);
    assert.match(v.error, /terminal/);
    // Legal chains still verify.
    assert.equal(verifyAudit(restrictedRevokedRecord()).ok, true);
  });
});

describe('consent-ledger P1 review fixes (fail-closed TDD)', () => {
  const T_MAR_USE = '2026-03-01T00:00:00.000Z'; // pre-restriction use
  const T_JUN_RESTRICT = '2026-06-01T00:00:00.000Z'; // general -> billing
  const T_JUL_USE = '2026-07-01T00:00:00.000Z'; // post-restriction use
  const T_SEP_REVOKE = '2026-09-01T00:00:00.000Z';
  const T_INTERIM = '2026-04-01T00:00:00.000Z'; // between Mar revoke and Jun tamper
  const T_LATE = '2027-06-01T00:00:00.000Z'; // between real and tampered expiry
  const GENERAL = 'general';
  const BILLING = 'billing';

  function generalGrant() {
    return grant({ purpose: GENERAL });
  }

  function restrictedRecord() {
    const r = applyEvent(generalGrant(), 'restricted', { at: T_JUN_RESTRICT, narrowedPurpose: BILLING });
    assert.equal(r.ok, true, `setup restrict failed: ${r.error}`);
    return r.record;
  }

  function fullBind(purpose, at) {
    return {
      purpose, subject: SUBJECT, tenant: TENANT, domain: DOMAIN, at,
    };
  }

  function fullDerived(purpose, derivedAt) {
    return {
      target: 'derived_memory', purpose, subject: SUBJECT, tenant: TENANT, domain: DOMAIN, derivedAt,
    };
  }

  it('P1-1: restriction applies prospectively — pre-restriction uses keep the granted purpose', () => {
    const rec = restrictedRecord();
    const marchGeneral = evaluateUse(rec, fullBind(GENERAL, T_MAR_USE));
    assert.equal(marchGeneral.decision, 'permit');
    const marchBilling = evaluateUse(rec, fullBind(BILLING, T_MAR_USE));
    assert.equal(marchBilling.decision, 'deny');
    // Post-restriction behavior is unchanged.
    assert.equal(evaluateUse(rec, fullBind(BILLING, T_JUL_USE)).decision, 'permit');
    assert.equal(evaluateUse(rec, fullBind(GENERAL, T_JUL_USE)).decision, 'deny');
  });

  it('P1-1b: validAtDerivation reconstructs purpose at the derivation instant', () => {
    const r1 = applyEvent(generalGrant(), 'restricted', { at: T_JUN_RESTRICT, narrowedPurpose: BILLING });
    assert.equal(r1.ok, true);
    const r2 = applyEvent(r1.record, 'revoked', { at: T_SEP_REVOKE });
    assert.equal(r2.ok, true);
    const preBroad = evaluateDerivedUse(r2.record, fullDerived(GENERAL, T_MAR_USE), { at: T_EXPIRED });
    assert.equal(preBroad.effective, false); // post-revocation now-state still invalid
    assert.equal(preBroad.validAtDerivation, true); // ... but broad was permitted-then
    const postBroad = evaluateDerivedUse(r2.record, fullDerived(GENERAL, T_JUL_USE), { at: T_EXPIRED });
    assert.equal(postBroad.validAtDerivation, false);
  });

  it('P1-2: derived entries missing subject/tenant/domain are ineffective (fail closed)', () => {
    const g = generalGrant();
    for (const drop of ['subject', 'tenant', 'domain']) {
      const entry = fullDerived(GENERAL, T_HISTORICAL);
      delete entry[drop];
      const d = evaluateDerivedUse(g, entry, { at: T_HISTORICAL });
      assert.equal(d.effective, false, `missing ${drop} still effective`);
      assert.equal(d.validAtDerivation, false);
      assert.equal(d.authorityGranted, false);
    }
    const allMissing = evaluateDerivedUse(g, {
      target: 'derived_memory', purpose: GENERAL, derivedAt: T_HISTORICAL,
    }, { at: T_HISTORICAL });
    assert.equal(allMissing.effective, false);
    assert.equal(allMissing.validAtDerivation, false);
  });

  it('P1-2b: bundle entries missing bindings are denied (fail closed)', () => {
    const g = generalGrant();
    const b = evaluateBundle([{ record: g, purpose: GENERAL, tenant: TENANT }], { at: T_HISTORICAL });
    assert.equal(b.decision, 'deny');
    assert.match(b.reason, /bundle_blocked/);
    assert.equal(b.authorityGranted, false);
  });

  it('P1-3: verifyAudit binds revoked_at to the revocation history entry', () => {
    const tampered = JSON.parse(JSON.stringify(revokedRecord()));
    tampered.revoked_at = T_USE; // move revocation later than the history entry
    const v = verifyAudit(tampered);
    assert.equal(v.ok, false);
    assert.match(v.error, /revok/);
    assert.equal(verifyAudit(revokedRecord()).ok, true); // untampered chain still verifies
  });

  it('P1-3b: interim uses between real and tampered revocation are denied', () => {
    const tampered = JSON.parse(JSON.stringify(revokedRecord()));
    tampered.revoked_at = T_USE;
    const interim = evaluateUse(tampered, fullBind(PURPOSE, T_INTERIM));
    assert.equal(interim.decision, 'deny');
    assert.match(interim.reason, /revok/);
    // Genuinely pre-revocation use stays permitted-then.
    const historical = evaluateUse(tampered, fullBind(PURPOSE, T_HISTORICAL));
    assert.equal(historical.decision, 'permit');
  });

  it('P1-3c: verifyAudit enforces expired/valid_until consistency', () => {
    const r = applyEvent(grant(), 'expired', { at: T_VALID_UNTIL });
    assert.equal(r.ok, true);
    assert.equal(verifyAudit(r.record).ok, true);
    const tampered = JSON.parse(JSON.stringify(r.record));
    tampered.valid_until = T_EXPIRED; // move expiry later than the history entry
    assert.equal(verifyAudit(tampered).ok, false);
    const interim = evaluateUse(tampered, fullBind(PURPOSE, T_LATE));
    assert.equal(interim.decision, 'deny');
    assert.match(interim.reason, /expir/);
  });

  it('P1-4: verifyAudit binds top-level grant fields to the genesis entry', () => {
    const g = generalGrant();
    const genesis = g.history[0].grant || {};
    assert.equal(genesis.subject, SUBJECT);
    assert.equal(genesis.purpose, GENERAL);
    assert.equal(genesis.scope_tenant, TENANT);
    assert.equal(genesis.scope_domain, DOMAIN);
    const mutations = [
      ['subject', 'user:mallory'],
      ['purpose', 'other-purpose'],
      ['scope_tenant', OTHER_TENANT],
      ['scope_domain', 'evil.example.com'],
    ];
    for (const [field, value] of mutations) {
      const tampered = JSON.parse(JSON.stringify(g));
      tampered[field] = value;
      const v = verifyAudit(tampered);
      assert.equal(v.ok, false, `mutated ${field} must not verify`);
      assert.match(v.error, /genesis|grant_binding/);
    }
    assert.equal(verifyAudit(g).ok, true);
  });

  it('P2-1: a use exactly at the expiry cutoff is denied', () => {
    const d = evaluateUse(grant(), fullBind(PURPOSE, T_VALID_UNTIL));
    assert.equal(d.decision, 'deny');
    assert.match(d.reason, /expir/);
  });

  it('P2-2: an artifact cannot be effective before its derivation instant', () => {
    const r = evaluateDerivedUse(generalGrant(), {
      ...fullDerived(GENERAL, T_JUL_USE),
    }, { at: T_MAR_USE });
    assert.equal(r.effective, false);
    assert.match(r.reason, /derivation/);
    assert.equal(r.validAtDerivation, false);
  });
});
