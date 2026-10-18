# Verified Auto Router v0.2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extend Trust Gateway's existing advisory model router into a backward-compatible policy-aware shadow router that can issue auditable route receipts and safely route Muse Spark 1.3 Contributor only when workload policy explicitly permits provider training use.

**Architecture:** Keep ownership inside Trust Gateway. Existing legacy requests continue through `ProviderRegistry.plan()` unchanged. Requests carrying Verified Auto policy fields take a policy-aware path that validates inputs fail-closed, filters a Trust-owned model metadata catalog, chooses a deterministic eligible route, issues a `model-route/1.0` receipt, and audits the decision. This wave is shadow/advisory only: it does not dispatch models, mutate Runtime/WORKS state, or claim verification.

**Tech Stack:** Node.js >=20, built-in `node:test`, `node:assert`, `node:crypto`; zero new runtime dependencies.

**Spec:** `Aftergraph/after-graph-governance` PR #41, `docs/superpowers/specs/2026-09-08-aftergraph-verified-auto-execution-design.md`, head `44e3f21b26f0495ee0ed3e5fb562cbc40dabe312`.

## Global Constraints

- Preserve existing `POST /v2/router/route` behavior for callers that send only `capability` and `budget_tier`.
- New restrictive policy fields fail closed when malformed or unsupported.
- `provider_training_allowed=false` must exclude models whose route metadata declares provider training/model-improvement use.
- `public` data never implies training permission.
- `restricted` must never select a training-eligible route.
- Route receipts are explanatory records, never authority tokens or verification receipts.
- No secrets, prompts, file contents, or arbitrary capability text may be copied into audit events.
- No new npm dependencies.
- No live provider calls in tests.
- Muse Spark 1.3 Contributor is an execution candidate, not an Aftergraph-owned model release or champion.
- This wave remains advisory/shadow only and must not alter dispatch behavior.

---

## File Structure

- Create `src/gateway/model-route-catalog.js`: Trust-owned operational metadata for models that are safe to use in policy-aware routing.
- Create `src/gateway/model-route-policy.js`: validation, eligibility filtering, deterministic ranking, and receipt construction helpers.
- Modify `src/gateway/providers.js`: register the direct Meta Model API provider and Muse Spark 1.3 standard/contributor IDs in the provider registry without changing legacy free-lane ranking.
- Modify `src/gateway/mounts/59-router.js`: detect policy-aware requests, invoke policy routing, preserve the legacy path, and audit non-secret reason codes.
- Create `tests/router-policy-v02.test.js`: request-validation, privacy/training, contributor eligibility, standard fallback, restricted-data, receipt, audit-redaction, and backwards-compatibility tests.
- Modify `docs/MODEL-ROUTER-v0.1.md`: document v0.2 additive shadow semantics and the data-use boundary.

---

### Task 1: Lock Policy-Aware Request Validation

**Files:**
- Create: `tests/router-policy-v02.test.js`
- Create: `src/gateway/model-route-policy.js`

**Interfaces:**
- Produces: `parsePolicyRouteRequest(body)` returning `{ ok: true, value }` or `{ ok: false, status: 400, error }`.
- Produces canonical values: `execution_mode in {'auto','verified'}`, `data_class in {'public','internal','confidential','restricted'}`.

- [ ] **Step 1: Write failing tests for invalid restrictive fields**

Add tests asserting:

```js
for (const body of [
  { execution_mode: 'fastest' },
  { data_class: 'secret-ish' },
  { provider_training_allowed: 'yes' },
  { max_cost_usd: -1 },
  { max_cost_usd: Number.POSITIVE_INFINITY },
  { execution_context_id: 'ctx_bad' },
]) {
  const r = await post(url, '/v2/router/route', body);
  assert.equal(r.status, 400);
}
```

Add a test proving the legacy request remains accepted:

```js
const r = await post(url, '/v2/router/route', { capability: 'code', budget_tier: 'free' });
assert.equal(r.status, 200);
const body = await r.json();
assert.equal(body.provider, 'ollama-cloud');
assert.equal(body.model, 'glm-5.3-flash');
assert.equal(body.receipt, undefined);
```

- [ ] **Step 2: Run the focused test and verify RED**

Run:

```bash
node --test tests/router-policy-v02.test.js
```

Expected: FAIL because malformed policy fields are currently ignored and no policy parser exists.

- [ ] **Step 3: Implement minimal parser**

Create `src/gateway/model-route-policy.js` with strict validation. Policy-aware mode is entered when any of these own-properties are present:

```js
const POLICY_FIELDS = new Set([
  'execution_mode',
  'data_class',
  'provider_training_allowed',
  'max_cost_usd',
  'verification',
  'execution_context_id',
]);
```

Rules:

```text
execution_mode: auto|verified, default auto
execution_mode=verified => verification defaults to exact_head for capability=code
verification: exact_head|null only in this wave
provider_training_allowed: boolean, required for policy-aware routing
data_class: public|internal|confidential|restricted, required for policy-aware routing
max_cost_usd: finite number >= 0 when present
execution_context_id: /^ctx_[a-f0-9]{32}$/ when present
```

Return stable error codes such as `invalid_execution_mode`, `data_class_required`, `provider_training_allowed_required`, `invalid_max_cost_usd`, `invalid_execution_context_id`.

- [ ] **Step 4: Run focused test and verify GREEN**

Run:

```bash
node --test tests/router-policy-v02.test.js
```

Expected: parser-related tests PASS while route-selection tests not yet added.

- [ ] **Step 5: Commit**

```bash
git add tests/router-policy-v02.test.js src/gateway/model-route-policy.js
git commit -m "test(router): lock Verified Auto request policy"
```

---

### Task 2: Add Trust-Owned External Model Metadata

**Files:**
- Create: `src/gateway/model-route-catalog.js`
- Modify: `src/gateway/providers.js`
- Test: `tests/router-policy-v02.test.js`

**Interfaces:**
- Produces: `ROUTE_MODELS` array.
- Produces: `getRouteModel(provider, model)`.
- Every route row contains `{provider, model, capabilities, external, dataUse, pricing, sourceCheckedAt}`.

- [ ] **Step 1: Write failing metadata tests**

Test that the provider registry exposes:

```js
const models = getRegistry(gw).models();
assert.ok(models.some((x) => x.provider === 'meta-model-api' && x.model === 'muse-spark-1.3'));
assert.ok(models.some((x) => x.provider === 'meta-model-api' && x.model === 'muse-spark-1.3-contributor'));
```

Test catalog semantics:

```js
const contributor = getRouteModel('meta-model-api', 'muse-spark-1.3-contributor');
assert.equal(contributor.dataUse, 'provider_training');
assert.equal(contributor.pricing.inputPerMtokUsd, 0.10);
assert.equal(contributor.pricing.outputPerMtokUsd, 0.20);

const standard = getRouteModel('meta-model-api', 'muse-spark-1.3');
assert.equal(standard.dataUse, 'no_provider_training');
```

- [ ] **Step 2: Run focused test and verify RED**

Run `node --test tests/router-policy-v02.test.js`.

Expected: FAIL because Meta provider and route metadata do not exist.

- [ ] **Step 3: Implement minimal catalog and provider seed**

Add provider to `SEED`:

```js
{
  name: 'meta-model-api',
  kind: 'direct',
  baseUrl: 'https://api.meta.ai/v1',
  models: ['muse-spark-1.3', 'muse-spark-1.3-contributor'],
  defaultModel: 'muse-spark-1.3',
}
```

Create catalog entries with pricing snapshot `2026-09-08`, capabilities `['code','reasoning','vision','multimodal']`, and explicit `dataUse` values. Do not put API keys, quotas, or account-specific state in the catalog.

The legacy `FREE_LANES` list remains byte-for-byte semantically unchanged so the existing free route stays primary for legacy `budget_tier=free`.

- [ ] **Step 4: Run tests and verify GREEN**

```bash
node --test tests/router-policy-v02.test.js tests/router.test.js tests/providers.test.js
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/gateway/model-route-catalog.js src/gateway/providers.js tests/router-policy-v02.test.js
git commit -m "feat(router): register Meta Spark 1.3 route metadata"
```

---

### Task 3: Enforce Data/Training Policy and Deterministic Route Choice

**Files:**
- Modify: `src/gateway/model-route-policy.js`
- Test: `tests/router-policy-v02.test.js`

**Interfaces:**
- Produces: `selectPolicyRoute({ registryModels, request, telemetry })` returning `{ primary, fallbacks, reasonCodes }` or `{ error: 'no_eligible_route' }`.

- [ ] **Step 1: Write failing policy tests**

Required cases:

```js
// Explicit permission: contributor is eligible and preferred for code/economy.
const allowed = await route({
  capability: 'code', execution_mode: 'auto', data_class: 'public',
  provider_training_allowed: true, max_cost_usd: 2,
});
assert.equal(allowed.model, 'muse-spark-1.3-contributor');

// No permission: contributor must not appear anywhere.
const denied = await route({
  capability: 'code', execution_mode: 'auto', data_class: 'public',
  provider_training_allowed: false, max_cost_usd: 10,
});
assert.notEqual(denied.model, 'muse-spark-1.3-contributor');
assert.ok(!denied.fallbacks.some((x) => x.model === 'muse-spark-1.3-contributor'));

// Restricted: training route excluded even if caller says true.
const restricted = await route({
  capability: 'code', execution_mode: 'auto', data_class: 'restricted',
  provider_training_allowed: true, max_cost_usd: 10,
});
assert.notEqual(restricted.model, 'muse-spark-1.3-contributor');
```

Add a fail-closed test where all eligible catalog rows exceed `max_cost_usd` and expect HTTP 409 with `no_eligible_route`.

- [ ] **Step 2: Run focused test and verify RED**

Expected: FAIL because the existing router does not inspect data/training policy.

- [ ] **Step 3: Implement minimal eligibility pipeline**

Filter in this strict order:

```text
known route metadata
training/data policy
capability
provider hard-blacklist from telemetry
max_cost_usd using a conservative one-MTok input + one-MTok output ceiling for V0.2 shadow comparison only
price ascending
provider/model lexical tie-break
```

For `restricted`, exclude every row with `external=true && dataUse==='provider_training'` regardless of the request boolean.

Unknown third-party rows are excluded from policy-aware routing until Trust metadata exists; legacy routing still sees them.

- [ ] **Step 4: Run focused + legacy tests and verify GREEN**

```bash
node --test tests/router-policy-v02.test.js tests/router.test.js
```

Expected: PASS and legacy primary remains `ollama-cloud/glm-5.3-flash` for free tier.

- [ ] **Step 5: Commit**

```bash
git add src/gateway/model-route-policy.js tests/router-policy-v02.test.js
git commit -m "feat(router): enforce data-aware route eligibility"
```

---

### Task 4: Issue RouteReceipt and Audit Without Sensitive Payloads

**Files:**
- Modify: `src/gateway/model-route-policy.js`
- Modify: `src/gateway/mounts/59-router.js`
- Test: `tests/router-policy-v02.test.js`

**Interfaces:**
- Produces: `createRouteReceipt({ request, selected, reasonCodes, now })`.
- Receipt schema string: `model-route/1.0`.
- Route id format: `/^rte_[a-f0-9]{32}$/`.

- [ ] **Step 1: Write failing receipt/audit tests**

Assert policy-aware response contains:

```js
assert.equal(body.receipt.schema, 'model-route/1.0');
assert.match(body.receipt.route_id, /^rte_[a-f0-9]{32}$/);
assert.equal(body.receipt.provider, body.provider);
assert.equal(body.receipt.model, body.model);
assert.equal(body.receipt.verification_required, true);
assert.deepEqual(body.receipt.selection.reason_codes, [...body.receipt.selection.reason_codes].sort());
```

Assert audit contains only allowlisted metadata:

```js
const audit = gw.chain.entries.find((e) => e.payload.type === 'model_route_policy');
assert.equal(audit.payload.routeId, body.receipt.route_id);
assert.equal(audit.payload.dataClass, 'public');
assert.equal(audit.payload.trainingAllowed, true);
assert.equal(JSON.stringify(audit.payload).includes('super-secret-capability-payload'), false);
```

- [ ] **Step 2: Run focused test and verify RED**

Expected: FAIL because no receipt exists.

- [ ] **Step 3: Implement receipt construction and mount integration**

Use `crypto.randomBytes(16).toString('hex')` for `route_id`. `issued_at` uses `new Date().toISOString()`.

Policy-aware HTTP response:

```json
{
  "model": "...",
  "provider": "...",
  "fallbacks": [],
  "receipt": { "schema": "model-route/1.0" }
}
```

Legacy response shape stays unchanged.

Audit event `model_route_policy` may contain only route id, execution mode, data class, boolean training permission, primary provider/model, fallback count, and reason codes. Do not copy `capability` raw text or `execution_context_id` into audit in this wave.

- [ ] **Step 4: Run focused + router tests and verify GREEN**

```bash
node --test tests/router-policy-v02.test.js tests/router.test.js
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/gateway/model-route-policy.js src/gateway/mounts/59-router.js tests/router-policy-v02.test.js
git commit -m "feat(router): issue policy-aware route receipts"
```

---

### Task 5: Document Shadow Rollout and Run Full Verification

**Files:**
- Modify: `docs/MODEL-ROUTER-v0.1.md`

**Interfaces:**
- Documents the additive V0.2 route request, contributor data-use boundary, fail-closed errors, and explicit statement that routing is advisory/shadow only.

- [ ] **Step 1: Update documentation**

Document these facts exactly:

```text
Legacy route: capability + budget_tier, unchanged.
Policy route: execution_mode + data_class + provider_training_allowed (+ optional max_cost_usd, verification, execution_context_id).
Contributor route is ineligible unless provider_training_allowed=true.
Restricted data never selects contributor.
model-route/1.0 is explanatory and not authority or verification evidence.
V0.2 does not dispatch models; Runtime integration is a later wave.
```

- [ ] **Step 2: Run complete repository test suite**

```bash
npm test
```

Expected: all tests pass, zero failures.

- [ ] **Step 3: Run syntax checks for changed production files**

```bash
node --check src/gateway/model-route-catalog.js
node --check src/gateway/model-route-policy.js
node --check src/gateway/mounts/59-router.js
node --check src/gateway/providers.js
```

Expected: exit 0 for each.

- [ ] **Step 4: Inspect diff for boundary violations**

```bash
git diff main...HEAD -- src/gateway tests docs/MODEL-ROUTER-v0.1.md
```

Reject the change if it introduces dispatch, model API keys, prompt logging, WORKS state writes, verification claims, or a new dependency.

- [ ] **Step 5: Commit**

```bash
git add docs/MODEL-ROUTER-v0.1.md
git commit -m "docs(router): document Verified Auto shadow routing"
```

---

## Exit Criteria

The wave is complete only when all are true:

1. Legacy router tests pass unchanged.
2. Policy fields fail closed on malformed values.
3. Contributor is selectable only with explicit training permission and never for `restricted`.
4. Standard Muse Spark remains available as the non-training Meta route.
5. Policy-aware requests receive a `model-route/1.0` receipt.
6. Audit events contain route metadata but no arbitrary task/prompt content.
7. Full `npm test` passes.
8. The PR description labels the feature shadow/advisory only.
9. No code in this wave dispatches a model or claims verified completion.
