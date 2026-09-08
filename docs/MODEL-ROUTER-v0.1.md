# Model Router v0.1

A minimal model router that selects models based on cost, capability, availability, and governance constraints.

## Routing Rules

### Cost Ceiling
- `budget_tier` controls maximum acceptable cost:
  - `free` — only free-tier models (marked `free: true` in catalog)
  - `economy` — free + lowest-cost paid models
  - `standard` — standard cost models (default)
  - `premium` — all models including premium/high-performance

### Capability Match
- `capability` string filters for models supporting the requested feature:
  - `code` — code generation/refactoring
  - `reasoning` — analytical/chain-of-thought tasks
  - `vision` — image understanding
  - `multimodal` — mixed media handling

### Provider Availability
- Primary selection uses `reg.plan()` heuristic (from providers.js)
- Falls back in order when primary fails or is unavailable

## Fallback Chain

1. **Primary**: Highest-ranked model matching constraints
2. **Secondary**: Next-ranked model from same provider tier
3. **Break-glass**: Any available AIE-approved model (no capability filter)

## Governance Constraints

- Only AIE-approved models in the provider catalog may be routed
- All routing decisions logged to audit chain
- No model keys or sensitive data exposed in responses
- Break-glass fallback only triggered when explicitly enabled

## API

### POST /v2/router/route

**Request:**
```json
{
  "capability": "code",
  "budget_tier": "economy"
}
```

**Response:**
```json
{
  "model": "glm-5.3-flash",
  "provider": "ollama-cloud",
  "fallbacks": [
    {"model": "minimax/minimax-m3:free", "provider": "openrouter"},
    {"model": "laguna-s-2.1-free", "provider": "opencode-zen"}
  ]
}
```

## Implementation Notes

- Minimal: 1 mount file, 1 doc file
- No new dependencies
- Leverages existing provider registry and plan() heuristic
- Advisory mode: does not block dispatch flow

---

# Model Router v0.2 — Verified Auto shadow contract

v0.2 adds an explicit policy-aware routing contract while preserving the v0.1 request path unchanged. It is a **shadow/advisory router**: it selects and explains an eligible route but does not dispatch model calls, mutate Runtime/WORKS state, grant authority, or claim execution verification.

## Policy-aware request

A request opts into v0.2 when it supplies any v0.2 policy field.

```json
{
  "capability": "code",
  "execution_mode": "verified",
  "data_class": "public",
  "provider_training_allowed": true,
  "max_cost_usd": 2,
  "execution_context_id": "ctx_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
}
```

Supported fields:

- `capability`: `code`, `reasoning`, `vision`, or `multimodal` when capability filtering is needed.
- `execution_mode`: `auto` or `verified`; defaults to `auto` for a policy-aware request.
- `data_class`: required; one of `public`, `internal`, `confidential`, `restricted`.
- `provider_training_allowed`: required boolean. A provider-training route is eligible only when this is explicitly `true` and the data class permits it.
- `max_cost_usd`: optional non-negative finite number used as the current shadow comparison-budget ceiling.
- `verification`: optional; currently `exact_head` is the supported verification marker.
- `execution_context_id`: optional opaque context identifier matching `ctx_<32 lowercase hex>`.

Invalid restrictive fields fail closed with HTTP `400`. A valid request with no eligible route fails closed with HTTP `409` and `{"error":"no_eligible_route"}`.

### Important budget limitation

`max_cost_usd` is **not actual billed request cost** in this shadow slice. The selector currently compares catalog input + output per-million-token pricing as a deterministic ranking/budget proxy. Actual token usage, cache usage, provider billing, retries, and final settled cost belong to the later Runtime/WORKS execution slices.

## Data-use policy

The catalog distinguishes provider-training routes from routes marked as not using request data for provider training.

For Meta Model API Spark 1.3:

- `muse-spark-1.3-contributor` is tagged `provider_training` and is eligible only when `provider_training_allowed=true` and `data_class` is not `restricted`.
- `muse-spark-1.3` is tagged `no_provider_training` and remains eligible when provider training is denied.
- `restricted` data always excludes Contributor even when the caller sets `provider_training_allowed=true`.

`no_provider_training` is a routing-policy metadata claim only. It does **not** imply zero data retention, zero-log processing, or any broader provider privacy guarantee unless a separate provider contract explicitly establishes that property.

## Selection order

For policy-aware requests the current shadow selector filters/ranks candidates by:

1. provider/model present in the governed registry
2. data-use eligibility
3. requested capability
4. provider health blacklist
5. comparison-budget ceiling
6. deterministic cost ranking

The selected route includes stable, sorted `reason_codes` explaining why it was eligible and chosen.

## RouteReceipt — `model-route/1.0`

Every successful policy-aware route returns a receipt:

```json
{
  "model": "muse-spark-1.3-contributor",
  "provider": "meta-model-api",
  "fallbacks": [],
  "receipt": {
    "schema": "model-route/1.0",
    "route_id": "rte_0123456789abcdef0123456789abcdef",
    "issued_at": "2026-09-08T10:00:00.000Z",
    "provider": "meta-model-api",
    "model": "muse-spark-1.3-contributor",
    "verification_required": true,
    "selection": {
      "reason_codes": [
        "capability_match",
        "cost_ranked",
        "policy_eligible",
        "provider_healthy",
        "provider_training_permitted"
      ]
    }
  }
}
```

Receipt properties:

- `schema` is `model-route/1.0`.
- `route_id` is `rte_` plus 32 lowercase hexadecimal characters generated from cryptographic randomness.
- `issued_at` is an ISO-8601 timestamp.
- `provider` and `model` identify the selected route.
- `verification_required` is true when the request uses `execution_mode=verified` or supplies a verification requirement.
- `selection.reason_codes` is de-duplicated and sorted.

A RouteReceipt proves the gateway's routing decision. It does **not** prove that the model was invoked, that work completed, or that a result was independently verified.

## Audit hygiene

Policy-aware decisions emit `model_route_policy` to the tamper-evident audit chain. The payload is allowlisted to:

- `routeId`
- `executionMode`
- `dataClass`
- `trainingAllowed`
- `primaryProvider`
- `primaryModel`
- `fallbackCount`
- `reasonCodes`

The audit event deliberately excludes capability/request payload text and `execution_context_id`. Provider keys, prompts, model input/output, and other execution payloads are not written by this router event.

The legacy path continues to emit its existing `model_route` event and returns no receipt.

## Compatibility boundary

The original request remains supported byte-shape compatibly:

```json
{
  "capability": "code",
  "budget_tier": "free"
}
```

It continues through the existing `reg.plan()` path, preserving legacy provider selection/fallback semantics and response shape. Supplying v0.2 policy fields explicitly opts into the new policy selector.

## Shadow-mode boundary

Router v0.2 currently owns **selection policy and evidence only**. It does not:

- call a model provider
- reserve or settle real execution cost
- pin a model across retries or context windows
- write execution attempts into WORKS
- perform Sentinel verification
- grant/revoke execution authority
- turn a RouteReceipt into proof of completion

Those concerns belong to subsequent rollout waves. Until those integrations land and pass their own gates, v0.2 should be described as **shadow ready**, not end-to-end Verified Auto execution.
