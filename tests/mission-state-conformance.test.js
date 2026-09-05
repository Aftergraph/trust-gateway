'use strict';
// H7: Mission-state conformance — to lag, begge verificeret:
//
// 1) MISSION LIFECYCLE (kontrakt: after-graph-governance/docs/contracts/mission-state/1.0.json)
//    12 states (DRAFT→READY→AUTHORIZED→RUNNING→...→VERIFIED/FAILED/CANCELLED/REVOKED).
//    AIE er autoritativ for mission lifecycle (engine.py Mission.state).
//
// 2) PROPOSAL LIFECYCLE (TG: src/gateway/missions.js MissionProposalStore)
//    draft → submitted → approved | rejected | expired.
//    Proposals er INTENT-laget FØR en mission eksisterer — ikke mission states.
//    De to lag MÅ ikke forveksles: approved proposal ≠ AUTHORIZED mission.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

// --- Kontrakt (1.0.json) ---
const contractPath = path.join(
  process.env.GOVERNANCE_DIR || path.join(__dirname, '..', '..', 'after-graph-governance'),
  'docs', 'contracts', 'mission-state', '1.0.json',
);
let contract = null;
try {
  contract = JSON.parse(fs.readFileSync(contractPath, 'utf8'));
} catch (_) {
  // Kontrakten ikke fundet — tests fejler ærligt (cross-repo afhængighed)
}

const VALID_STATES = contract
  ? new Set(Object.keys(contract.mission_state_machine || {}))
  : null;

const { MissionProposalStore, PROPOSAL_TTL_MS } = require('../src/gateway/missions');

// =====================================================================
// LAG 1 — MISSION LIFECYCLE (kontrakt 1.0.json)
// =====================================================================

test('H7: mission-state 1.0.json kontrakten findes', () => {
  assert.ok(contract, '1.0.json skal findes via GOVERNANCE_DIR eller ../../after-graph-governance');
  assert.ok(contract.mission_state_machine, 'mission_state_machine skal defineres');
  assert.ok(Array.isArray(contract.required) && contract.required.length >= 1, 'required felter skal defineres');
  assert.ok(Array.isArray(contract.mission_invariants), 'mission_invariants skal være array');
  assert.ok(contract.mission_invariants.length >= 4, 'mindst 4 invariants (ISR SPEC-001 + AIE TH-12 + W0.4)');
});

test("H7: FSM'en er konsistent — ingen transition peger på ukendt state", () => {
  assert.ok(VALID_STATES, 'kontrakt loadet');
  for (const [from, config] of Object.entries(contract.mission_state_machine)) {
    assert.ok(VALID_STATES.has(from), `FSM-state "${from}" skal findes i enum`);
    for (const to of (config.to || [])) {
      assert.ok(VALID_STATES.has(to), `FSM-transition "${from} -> ${to}" — "${to}" skal findes i enum`);
    }
  }
});

test('H7: terminal states (VERIFIED/FAILED/CANCELLED/REVOKED) har ingen udgående transitions', () => {
  assert.ok(VALID_STATES);
  for (const s of ['VERIFIED', 'FAILED', 'CANCELLED', 'REVOKED']) {
    const cfg = contract.mission_state_machine[s];
    assert.ok(cfg, `terminal state "${s}" skal eksistere i FSM`);
    assert.equal(cfg.to.length, 0, `terminal state "${s}" må IKKE have udgående transitions`);
  }
});

test('H7: polygon-mask — alle 12 mission-states eksisterer i FSM (komplet dækning)', () => {
  assert.ok(VALID_STATES);
  assert.equal(VALID_STATES.size, 12, 'kontrakten skal definere præcis 12 states');
  const expected = ['DRAFT', 'READY', 'AUTHORIZED', 'RUNNING', 'PAUSED', 'VERIFYING',
    'VERIFIED', 'RECOVERING', 'NEEDS_INPUT', 'FAILED', 'CANCELLED', 'REVOKED'];
  for (const s of expected) {
    assert.ok(VALID_STATES.has(s), `state "${s}" skal findes i FSM`);
  }
});

test('H7: fail-closed invariant — REVOKED og FAILED er utilgængelige fra RUNNING? (kontrakt-baseret)', () => {
  assert.ok(VALID_STATES);
  // RUNNING kan gå til REVOKED (revoked authority must remain revoked)
  assert.ok(contract.mission_state_machine.RUNNING.to.includes('REVOKED'),
    'RUNNING skal kunne gå til REVOKED');
  // AUTHORIZED kan ikke springe direkte til VERIFIED (complete != verified)
  assert.ok(!contract.mission_state_machine.AUTHORIZED.to.includes('VERIFIED'),
    'AUTHORIZED må IKKE gå direkte til VERIFIED (ISR SPEC-001 Invariant 1)');
});

test('H7: invariants inkluderer evidence-gating og revalidation', () => {
  assert.ok(contract);
  const inv = contract.mission_invariants.join(' ').toLowerCase();
  assert.ok(inv.includes('evidence'), 'invariant skal nævne evidence-gating (ISR SPEC-001 #2)');
  assert.ok(inv.includes('revalidat'), 'invariant skal nævne revalidation (AIE TH-12)');
  assert.ok(inv.includes('hmac') || inv.includes('persist') || inv.includes('tamper'),
    'invariant skal nævne persistent/tamper-evidence (AIE W0.4)');
});

// =====================================================================
// LAG 2 — PROPOSAL LIFECYCLE (TG MissionProposalStore)
// =====================================================================

function freshStore() {
  // now() stub så TTL-testen er deterministisk
  let t = 0;
  return new MissionProposalStore({ now: () => new Date(1700000000000 + t).toISOString(), inc: () => { t += 60000; } });
}

test('H7: create() laver draft-proposal med korrekt initial state', () => {
  const store = freshStore();
  const p = store.create({ proposer: 'test', objective: 'conformance' });
  assert.equal(p.status, 'draft');
  assert.equal(p.approval_requested, true);
  assert.equal(p.approved_by, null);
  assert.equal(p.converted_to_mission_id, null);
});

test('H7: submit() draft → submitted, og afviser gentaget submit', () => {
  const store = freshStore();
  const p = store.create({ proposer: 'test', objective: 'conformance' });
  store.submit(p.id);
  assert.equal(store.get(p.id).status, 'submitted');
  assert.throws(() => store.submit(p.id), /cannot submit from status submitted/);
});

test('H7: approve() submitted → approved, og afviser spring over draft', () => {
  const store = freshStore();
  const p = store.create({ proposer: 'test', objective: 'conformance' });
  // approve fra draft er ulovligt (fail-closed)
  assert.throws(() => store.approve(p.id, 'atlas'), /cannot approve from status draft/);
  store.submit(p.id);
  const a = store.approve(p.id, 'atlas');
  assert.equal(a.status, 'approved');
  assert.equal(a.approved_by, 'atlas');
  assert.ok(a.converted_to_mission_id, 'approve skal korrelere til mission id (W0.3)');
  // gentaget approve afvises
  assert.throws(() => store.approve(p.id, 'test'), /cannot approve from status approved/);
});

test('H7: reject() submitted → rejected, og afviser spring over draft', () => {
  const store = freshStore();
  const p = store.create({ proposer: 'test', objective: 'conformance' });
  assert.throws(() => store.reject(p.id, 'no'), /cannot reject from status draft/);
  store.submit(p.id);
  const r = store.reject(p.id, 'not needed');
  assert.equal(r.status, 'rejected');
  assert.equal(r.rejection_reason, 'not needed');
  assert.throws(() => store.reject(p.id, 'again'), /cannot reject from status rejected/);
});

test('H7: expired er en reel proposal-tilstand (lazy expiry)', () => {
  const store = freshStore();
  const p = store.create({ proposer: 'test', objective: 'conformance' });
  store.submit(p.id);
  // TTL passeret → get() ekspirerer og returnerer expired
  const now = store.now();
  const old = Date.parse(now);
  // Force: sæt submitted_at langt tilbage
  const pp = store.get(p.id);
  // Force TTL-expiry: sæt submitted_at langt tilbage
  pp.submitted_at = new Date(Date.parse(store.now()) - PROPOSAL_TTL_MS - 1000).toISOString();
  // Lazy expiry trigges på list() (read-path), ikke get()
  const listed = store.list();
  const e = listed.find((x) => x.id === p.id);
  assert.equal(e.status, 'expired');
});

test('H7: unknown id afvises fail-closed', () => {
  const store = freshStore();
  assert.throws(() => store.submit('nope'), /unknown id/);
  assert.throws(() => store.approve('nope', 'atlas'), /unknown id/);
  assert.throws(() => store.reject('nope', 'x'), /unknown id/);
});

test('H7: approved proposal MÅ IKKE forveksles med AUTHORIZED mission (to lag)', () => {
  const store = freshStore();
  const p = store.create({ proposer: 'test', objective: 'conformance' });
  store.submit(p.id);
  const a = store.approve(p.id, 'atlas');
  // Proposal-laget har IKKE mission lifecycle states — approved ≠ AUTHORIZED
  assert.equal(a.status, 'approved');
  assert.notEqual(a.status, 'AUTHORIZED', 'approved proposal er ikke en mission state');
  // men det korrelerer til en mission id der eksisterer på AIE-siden
  assert.ok(a.converted_to_mission_id.startsWith('mission_'));
});
