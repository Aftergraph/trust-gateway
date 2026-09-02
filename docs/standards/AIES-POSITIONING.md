# AIES-1 Positioning Note — Trust Gateway Mapping

**Status:** Research positioning note (not a conformance claim)
**Date:** 2026-09-02
**Subject:** AIES-1 "Agentic Institution Engineering Standard" Zero Draft v0.1 vs. Trust Gateway as-built
**Upstream doc:** AIES-1 Zero Draft v0.1 (2026-09-02, internal)

---

## 1. Why this note exists

AIES-1 proposes an institutional layer (mandate, authority, mission, evidence,
recourse) above control planes. Trust Gateway is the closest running system we
own that already implements *mechanisms* the draft requires — fail-closed
policy decisions outside the model, an immutable audit chain, TTL human
approvals. This note maps what exists, names the gaps honestly, and defines
what a real `experimental/aies-l1` claim would take.

**We do not claim AIES conformance today.** The draft is a Zero Draft with no
published schema. What we can claim: the draft's requirements are testable
against our code, and several already pass.

---

## 2. Requirement-by-requirement map

| AIES requirement | TG as-built | State |
|---|---|---|
| AIES-X003 — execution environment can deny independently of the model | `src/gateway/policy.js` `decide()` — pure function, decides **without executing**; server dispatches only on `allow` | **PASS** |
| AIES §16 — action classes (observational / reversible / consequential) | `classify()`: `read` / `write` / `destructive` / `secret`, fail-closed default to `destructive` | **PASS** (mapping: read→C0, write→C1, destructive+secret→C2) |
| AIES-E001 — evidence immutable after issuance | `src/gateway/hash-chain.js` — append-only, `hash = sha256(seq\|prevHash\|ts\|canonical(payload))`, `verify()` re-checks from genesis, refuses to load broken chains | **PASS** |
| AIES-E002 — evidence content-addressed | hash chain + canonical JSON | **PASS** |
| AIES-E003 — cryptographically attributable | none — chain proves integrity, not authorship. No signer key per entry | **GAP** |
| AIES-X004/X005 — consequential action produces Evidence bound to a Mission | audit entries exist; no Mission object to bind to | **PARTIAL** |
| AIES-H003/H004 — emergency path outside agent reasoning; kill not dependent on agent cooperation | `src/gateway/approvals.js` — human hold-outside; destructive always `needs_approval`; TTL fail-closed on expiry | **PARTIAL** (no institution-wide emergency-stop verb) |
| AIES-A001 — delegation must not amplify authority | no delegation chains at all; **plus one live anti-pattern:** `caps.includes('*')` grants universal capability | **GAP + HAZARD** |
| AIES-P001 — consequential action resolves to accountable Principal | bot id on audit entries; bot is the actor, root token holder is the accountability root | **PARTIAL** |
| AIES-M001 — autonomous principals operate under an active Mandate | no Mandate object | **GAP** |
| AIES-R002/R003 — resource limits enforced outside the reasoning model | no ResourceEnvelope; provider budgets live only in operator heads | **GAP** |
| AIES-C002 — constitution outranks delegated instructions | `docs/standards/AI-GOVERNANCE.md` exists but nothing machine-enforces precedence over policy.js rules | **PARTIAL (manual)** |
| AIES §35 — model may reason about policy but is not the enforcement boundary | architecture is exactly this: brain proposes, `decide()` + server audit dispose | **PASS** |

Score: **4 PASS, 4 PARTIAL, 4 GAP/HAZARD** of the draft's machine-checkable
requirements most relevant to a gateway. That is an honest L0.5–L1 starting
position, not conformance.

---

## 3. Hazards the mapping exposed (actionable now, independent of AIES)

1. **`'*'` capability is authority amplification.** `policy.js:36` — any bot
   holding `*` passes `hasCap` for every write-class tool. If we ever add
   delegation, a parent granting `*` violates AIES-A001 by construction.
   Fix candidate: forbid `*` in stored capabilities; expand at provision time.
2. **`approver` in approvals.js is an unverified string.** Fine for a
   single-operator PWA today; it is the exact hole AIES-X001/T8 (approval
   capture) warns about once a second actor exists.
3. **Audit chain has no per-entry signature.** Tamper-evidence is internal:
   an operator with write access can rebuild the whole chain. `AIES-E003`
   (ed25519 over entry hash) closes it cheaply.

---

## 4. What mapping to AIES would require (Stage-2 candidates)

In rough order of value-per-effort:

1. **`mission` object** (`id, mandate_ref, objective_digest, budget,
   evidence_required[]`) + thread `mission_id` through dispatcher → audit
   payload. Enables X005, CONF-007, MissionReceipt (§19).
2. **ResourceEnvelope enforcement point** in the dispatcher: per-mission
   token/EUR/time counters, metered server-side (never model-reported —
   R003), suspend on exhaustion (AIES-R004, CONF-006).
3. **`delegation.js`**: `grant(issuer, subject, capabilities ⊆ parent,
   expires ≤ parent)` with the attenuation check as a pure, unit-tested
   function; reject on first amplification (CONF-001, CONF-002).
4. **ed25519 sign on hash-chain append**; verification CLI `tg verify-evidence`
   (E003, §44 CLI sketch in the draft).
5. **Conformance harness**: encode the draft's 10 conformance cases (§33) as
   `tests/aies-conf.test.js` against the above. Green = claim
   `experimental/aies-l1`; with delegation + envelope green = `l2`.

---

## 5. Positioning statement (external use)

> Trust Gateway is a candidate reference implementation surface for AIES-1
> (Agentic Institution Engineering, Zero Draft): its policy engine, append-only
> evidence chain, and TTL approval flow already satisfy the draft's
> enforcement-outside-cognition and evidence-immutability requirements; the
> Mission/ResourceEnvelope/Delegation primitives are the planned next layer.

Do not use the word "standard" about AIES in any public material until it has
a published schema and one independent implementation (§42 Stage 5 of the
draft itself says a single implementation is insufficient).

---

## 6. Prior-art boundary (one-line distinctions, full matrix in AVC docs)

- **OWASP ACS (2026-09-01):** runtime hooks/enforcement — AIES = the semantics
  those hooks enforce. Complementary; ACS is the *how*, AIES the *by whom*.
- **IETF draft-niyikiza-oauth-attenuating-agent-tokens** (Standards Track,
  OAuth WG) and **draft-prakash-aip** (IBCT/Biscuit chains): token-level
  attenuation. AIES-A001..A005 must be shown *equivalent-or-stricter* than
  these, or it will be dismissed as reinvention.
- **MCP 2026-07-28 Tasks:** durable handles, cooperative cancel — leaves
  temporal validity (task outliving its authorization) to implementers. That
  residue is exactly AIES §26 + revocation-propagation territory.
- **AEI "AEBOP" / "AES" agentic-engineering-standard:** practice framework and
  config-artifact format respectively; neither is an interoperability spec for
  institutions. No overlap on the object layer.
