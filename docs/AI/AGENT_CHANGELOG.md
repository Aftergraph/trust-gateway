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
- pending PR

## 2026-09-05 — delegation-chain gateway scope
- fix: WeakMap-scoped chain per Gateway instance; prevents cross-gateway graph leakage
- 30 relevant tests green
- PR #8 merged → main 0307254
- remaining risk: graph state is not restart-durable

## 2026-09-05 — delegation-chain durable store
- feat: DurableDelegationChain with atomic 0600 persistence and fail-closed load
- optional Gateway delegationChainFile wiring
- 37 graph/UI tests green
- PR #10 merged → main e505e78

## 2026-09-05 — tenant-safe delegation graph path
- feat: delegationChainFile() derives paths through tenant-scope/dataRoot
- Gateway delegationChainTenantId wiring; 41 graph/UI tests green
- PR #12 merged → main eae4271

## 2026-09-05 — delegation message-id correction
- fix: hook uses deliver result's actual message id; no array-index fallback
- 43 graph/UI tests green
- PR #14 merged → main 5962f8b
- audit follow-up: Windows ACL hardening remains open
