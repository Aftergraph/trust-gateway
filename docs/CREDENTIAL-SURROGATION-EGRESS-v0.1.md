# Credential Surrogation and Governed Egress Boundary v0.1

Status: PROPOSED
Owner: Trust Gateway
Tracks: Aftergraph/trust-gateway#80, Aftergraph/after-graph-governance#68
Evidence class: architecture contract only; no production-isolation or security claim is implied by this document.

## 1. Purpose

Persistent autonomous agents should not receive raw provider credentials and should not be able to create an alternate network path around runtime admission.

This document defines the Trust Gateway contract for two related controls:

1. credential surrogation: the agent/runtime receives an opaque handle instead of a real secret;
2. governed egress: a concrete outbound request is admitted immediately before dispatch and may resolve a real credential only after the request is allowed.

The design preserves the canonical platform boundaries:

```text
AIE
  authority / delegation / purpose / budget semantics
        ↓
Trust Gateway
  identity-bound admission / policy / approval / revocation / secret brokerage
        ↓
Runtime
  process / tool / connector orchestration
        ↓
WORKS
  durable execution / leases / recovery / execution evidence when required
        ↓
independent verification
```

Trust Gateway does not mint institutional authority. It evaluates a requested action against authority and policy inputs supplied by canonical owners.

## 2. Security objective

The target invariant is:

```text
agent-visible credential material != provider credential material
```

A successful agent compromise must not, by itself, reveal reusable provider credentials or authorize arbitrary outbound requests.

A request is executable only when all of the following remain valid at dispatch time:

```text
principal
AND mission
AND purpose
AND authority reference
AND capability/scope
AND credential-handle binding
AND approval state when required
AND destination policy
AND revocation state
AND expiry
AND request integrity
```

Planning-time validity is not sufficient.

## 3. Threat model

### 3.1 In scope

- prompt injection causes an agent to request an unrelated endpoint;
- malicious or compromised agent code attempts to read or log credentials;
- a handle is replayed after expiry;
- a handle issued for principal A is used by principal B;
- a handle issued for mission A is used by mission B;
- a handle is used for a destination or scope outside its grant;
- authority or approval is revoked after planning but before network dispatch;
- a connector mutates destination/path/method after policy evaluation;
- an unknown destination is requested;
- request metadata or error handling accidentally records a raw secret;
- a runtime attempts to bypass the governed egress seam;
- an approved request is replayed with altered body or parameters.

### 3.2 Out of scope for v0.1

- proving host/kernel isolation;
- solving arbitrary covert channels;
- replacing AIE authority/delegation semantics;
- defining provider-specific OAuth login UX;
- browser-origin security as a complete subsystem;
- transport-layer TLS implementation details;
- claiming eBPF, namespace, container or VM equivalence.

Runtime isolation is tracked separately by Aftergraph/runtime#104.

## 4. Credential handle

A credential handle is an opaque, non-secret reference that can be carried by an agent/runtime without exposing the underlying provider credential.

Candidate logical shape:

```json
{
  "schema": "credential.handle/0.1",
  "handle_id": "ch_...",
  "principal_id": "principal/...",
  "mission_id": "mission/...",
  "authority_ref": "authority/...",
  "purpose": "publish_release",
  "credential_class": "github_app_installation",
  "allowed_destinations": ["api.github.com"],
  "allowed_methods": ["POST", "PATCH"],
  "scope_refs": ["repo:Aftergraph/example"],
  "issued_at": "...",
  "expires_at": "...",
  "nonce": "..."
}
```

The serialized handle given to the agent SHOULD contain only the opaque handle id. Binding metadata remains in the Gateway-owned store unless a non-secret projection is explicitly required for introspection.

### 4.1 Required properties

- unguessable identifier;
- principal-bound;
- mission-bound;
- authority-reference-bound;
- purpose-bound;
- destination/scope constrained;
- expiring;
- revocable;
- auditable without revealing the secret;
- non-transferable by default.

### 4.2 Forbidden properties

A handle MUST NOT:

- contain the provider token in plaintext, reversible encoding or metadata;
- become authority merely because it exists;
- be accepted after expiry or revocation;
- be usable by a foreign principal or mission;
- widen the scope of its authority reference;
- silently refresh itself into broader authority.

## 5. Handle lifecycle

```text
REQUEST
  ↓
RESOLVE AUTHORITY/POLICY INPUTS
  ↓
ISSUE HANDLE
  ↓
ACTIVE
  ├─> EXPIRED
  ├─> REVOKED
  └─> ROTATED -> successor handle
```

The provider secret may rotate independently. Rotation MUST NOT change the semantic scope of an already-issued handle.

If a secret is rotated and an active handle remains valid, the broker may bind the handle to the new provider secret only when the new secret represents equivalent or narrower provider authority.

## 6. Governed egress request

Every consequential external request that requires protected network access or a brokered credential must be representable as a Trust Gateway admission object.

Candidate logical shape:

```json
{
  "schema": "egress.request/0.1",
  "request_id": "er_...",
  "correlation_id": "corr_...",
  "principal_id": "principal/...",
  "mission_id": "mission/...",
  "authority_ref": "authority/...",
  "purpose": "publish_release",
  "credential_handle": "ch_...",
  "destination": {
    "scheme": "https",
    "host": "api.github.com",
    "port": 443
  },
  "http": {
    "method": "POST",
    "path": "/repos/Aftergraph/example/releases",
    "query_keys": [],
    "body_digest": "sha256:..."
  },
  "data": {
    "sensitivity": ["internal"],
    "provenance_refs": ["evidence/..."],
    "lineage_id": "lineage/..."
  },
  "requested_at": "..."
}
```

The exact transport representation may differ. The semantic fields above are the minimum target for policy evaluation and audit correlation.

## 7. Admission sequence

The canonical execution sequence is:

```text
1. Runtime constructs concrete request intent.
2. Runtime sends egress.request to Trust Gateway.
3. Gateway authenticates caller/principal binding.
4. Gateway resolves credential handle.
5. Gateway checks expiry and revocation.
6. Gateway verifies mission, authority reference, purpose and scope bindings.
7. Gateway evaluates destination/method/path/data-policy input.
8. Gateway resolves approval state if policy requires human approval.
9. Gateway revalidates all mutable conditions at execution time.
10. Gateway writes decision/audit intent before dispatch.
11. If ALLOW, privileged broker resolves the real secret.
12. Request is dispatched through the governed network boundary.
13. Result metadata is correlated back to the request without exposing the secret.
14. Audit/evidence records disposition and correlation ids.
```

If any required fact is unresolved, stale, unknown or contradictory, the request fails closed.

## 8. Request integrity

Admission applies to a concrete request, not a vague capability such as `network.write`.

At minimum, the admitted request identity binds:

```text
principal
mission
authority_ref
purpose
credential_handle
destination
method
path/resource
body digest or equivalent payload commitment
expiry window
```

Mutation after admission invalidates the decision and requires re-admission.

## 9. Secret replacement boundary

The real credential is resolved only inside a privileged broker/dispatcher boundary after `ALLOW`.

The agent-visible process must not receive the resolved secret as:

- an environment variable;
- command-line argument;
- tool result;
- exception string;
- log field;
- audit payload;
- evidence payload;
- model context.

Provider-specific adapters MAY inject the secret directly into the outbound transport (for example as an Authorization header) after admission.

The transport adapter MUST redact provider error responses that could echo credentials or secret-derived material.

## 10. Destination policy

Unknown destinations fail closed by default.

Policy inputs SHOULD support:

- exact host;
- host class / registered provider identity;
- scheme and port;
- method/protocol;
- resource/path pattern;
- principal;
- mission;
- declared purpose;
- authority reference;
- data sensitivity/provenance labels;
- credential class;
- approval requirement;
- rate/budget policy refs where available.

DNS resolution alone is never an authority decision.

Redirects MUST be treated as destination changes. A redirect to a destination outside the admitted set requires a new admission decision.

## 11. Execution-time revalidation

The following conditions are mutable and MUST be checked immediately before dispatch:

- handle expiry;
- handle revocation;
- authority revocation/version if exposed by the canonical authority source;
- approval expiry/revocation;
- destination policy state;
- mission lifecycle eligibility;
- caller/principal binding.

A plan generated while all conditions were valid does not retain permission after any of these change.

## 12. Audit contract

Audit MUST be sufficient to reconstruct:

- who requested the action;
- for which mission and purpose;
- which authority reference was evaluated;
- which handle id was used;
- which destination/resource was targeted;
- which policy/approval disposition occurred;
- whether dispatch happened;
- request/result correlation ids;
- why a request was denied or failed.

Audit MUST NOT contain:

- raw provider credentials;
- refresh tokens;
- secret-bearing headers;
- secret-bearing request bodies unless independently redacted/authorized;
- credential material copied from provider error output.

## 13. Failure semantics

Stable failure categories for the first implementation SHOULD distinguish:

- `credential_handle_unknown`
- `credential_handle_expired`
- `credential_handle_revoked`
- `credential_handle_principal_mismatch`
- `credential_handle_mission_mismatch`
- `credential_handle_scope_mismatch`
- `authority_unresolved`
- `authority_revoked`
- `approval_required`
- `approval_expired`
- `destination_unknown`
- `destination_denied`
- `request_mutated_after_admission`
- `secret_broker_unavailable`
- `dispatch_failed`

Failure output must remain secret-safe.

## 14. Ownership boundaries

### AIE owns

- legitimate authority semantics;
- delegation/attenuation;
- purpose and revocation semantics;
- budget inheritance/conservation semantics where applicable.

### Trust Gateway owns

- authenticated admission;
- policy evaluation;
- approvals;
- credential handle store;
- secret brokerage;
- execution-time revalidation;
- egress decision/audit.

### Runtime owns

- building the concrete request intent;
- process/tool/connector orchestration;
- forwarding provenance/sensitivity/lineage facts;
- ensuring there is no ungoverned alternate dispatch path in the supported runtime profile.

### WORKS owns

- durable work identity and execution state where the action participates in durable work;
- durable execution evidence/quittance;
- idempotency/effect reconciliation where owned by WORKS contracts.

No ownership statement in this document upgrades AIE conformance, Runtime isolation, WORKS verification or scientific evidence.

## 15. Deterministic test plan

Minimum tests before v0.1 can be called implemented:

1. raw secret never appears in agent-visible handle serialization;
2. raw secret never appears in audit/log/error fixtures;
3. unknown handle denied;
4. expired handle denied;
5. revoked handle denied;
6. foreign principal denied;
7. foreign mission denied;
8. destination outside handle scope denied;
9. method/path outside scope denied;
10. unknown destination denied;
11. request mutation after admission denied/re-admitted;
12. approval expiry between planning and dispatch blocks request;
13. authority revocation between planning and dispatch blocks request;
14. redirect outside admitted destination fails closed;
15. allowed request resolves secret only inside broker boundary;
16. dispatch correlation can be reconstructed without secret leakage;
17. broker outage fails closed;
18. existing destructive/secret/approval guarantees remain green.

## 16. Adversarial tests

The implementation test corpus SHOULD include:

- prompt-injected URL substitution;
- credential-handle theft/replay;
- connector attempts to log request headers;
- malicious redirect;
- TOCTOU revocation immediately before dispatch;
- encoded/alternate-host destination variants;
- provider error echoing an Authorization header;
- concurrent reuse of a one-shot handle if one-shot semantics are enabled.

## 17. Rollout

Recommended rollout sequence:

```text
SPEC_ONLY
  ↓
LOCAL_FIXTURES
  ↓
SHADOW_DECISION
  ↓
BROKERED_TEST_PROVIDER
  ↓
SINGLE_CONNECTOR_ENFORCED
  ↓
SUPPORTED_RUNTIME_PROFILE_ENFORCED
```

No production-wide enforcement claim should be made before the supported runtime profile proves that protected egress cannot bypass this boundary.

## 18. Non-goals

This design deliberately does not:

- clone a vendor-specific security subsystem;
- require a specific container or VM technology;
- move authority semantics into Trust Gateway;
- make every network read consequential by definition;
- equate an audit trail with independently verified business outcome;
- claim a secure host boundary before Runtime isolation evidence exists.

## 19. Promotion gate

`credential-surrogation-egress/0.1` may be promoted from PROPOSED only when:

- schemas/implementation exist;
- deterministic and adversarial tests pass;
- secret non-disclosure tests pass;
- revocation-at-dispatch is proven;
- at least one concrete connector/provider integration uses the brokered path;
- supported Runtime integration proves the governed seam is used;
- documentation names remaining bypasses/limitations explicitly.
