# AGENT_CHANGELOG

## 2026-09-05 — delegation-chain store
- feat: DelegationChain class (record/chain/tree/verify)
- 10 tests, all green
- PR #5 merged → main 441607f

## 2026-09-05 — delegation-chain mount
- feat: GET /v2/rooms/:id/chain endpoint
- hookRoomStore() records A2A delegation edges from message chain field
- 4 tests, all green
- PR #6 merged → main 5768489

## 2026-09-05 — delegation-chain rooms panel
- feat: Delegation tab with XSS-safe collapsible HTML/CSS tree
- fetches GET /v2/rooms/:id/chain on first tab activation
- 3 static UI contract tests + existing panel suite green

## 2026-09-05 — delegation-chain gateway scope
- fix: WeakMap-scoped chain per Gateway instance; prevents cross-gateway graph leakage
- PR #8 merged → main 0307254

## 2026-09-05 — delegation-chain durable store
- feat: DurableDelegationChain with atomic 0600 persistence and fail-closed load
- optional Gateway delegationChainFile wiring
- PR #10 merged → main e505e78

## 2026-09-05 — tenant-safe delegation graph path
- feat: delegationChainFile() derives paths through tenant-scope/dataRoot
- Gateway delegationChainTenantId wiring
- PR #12 merged → main eae4271

## 2026-09-05 — delegation message-id correction
- fix: hook uses deliver result's actual message id; no array-index fallback
- PR #14 merged → main 5962f8b

## 2026-09-05 — request-time tenant-bound delegation graphs
- feat: resolve tenant in routing and select tenant-specific graph backend
- cross-tenant chain reads/writes covered
- PR #16 merged → main f8d6470

## 2026-09-05 — structured verify + Windows ACL doc
- refactor: DelegationChain.verify() returns {valid, error} distinguishing cycle vs missing_edge
- docs: Windows ACL boundary documented
- atomic 0600 openSync+fsync backported to 7 store files
- PR #18 merged → main 8e24da0, also commits 7f04146 and 84865c5

## 2026-09-05 — developer platform v1: fn-routes in API contract
- feat: buildContract accepts fnRoutes array alongside static mounts
- GET /v2/rooms/:id/chain etc now visible in OpenAPI contract
- P2 delegation-chain now complete; 46 tests green