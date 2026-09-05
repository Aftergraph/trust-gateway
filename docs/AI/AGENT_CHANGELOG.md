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
