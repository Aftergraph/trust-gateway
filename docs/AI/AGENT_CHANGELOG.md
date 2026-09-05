## 2026-09-05 — E3: missions-panel (chat-missioner synlige + godkendbare)
- feat: /v2/proposals-liste m. status + submit/approve/reject (operator)
- Wiret i CHAT-nav; mission-correlation vist
- missions-panel 4/4; chat-scope 17/17

## 2026-09-05 — E1: mission.create tool (chat → MissionProposal, altid approval)
- feat: dedikeret 'mission'-klasse i policy — needs_approval ALTID, capabilities kan ikke auto-godkende
- End-to-end verificeret: proposal → submit → approve → WORKS-correlation
- 2/2 + policy/rbac/chat/missions 40/40

## 2026-09-05 — D1: mobil chat-polish (12/12 SLICES KOMPLET)
- feat: chat-tråd fuldskærm på mobil, compose pinned m. safe-area, 44px tap-targets
- viewport interactive-widget; prefers-reduced-motion (WCAG 2.3.3)
- mobile-polish 3/3 — chat-overgrowth-roadmap 12/12 LANDET

## 2026-09-05 — D2: approval-notify + unread-badges
- feat: Telegram-notify ved pending approvals (opt-in, fail-open, ingen secrets)
- UI: unread-badges pr. room (live, nulstilles ved open)
- notify 2/2; panel 11/11

## 2026-09-05 — D3: command palette + tema-toggle
- feat: cmd+K palette (filter/keyboard-navigation) + dark/light m. localStorage
- Panel-navigation + tema registreret som kommandoer
- palette 4/4 tests

## 2026-09-05 — B2: voice i rooms (BØLGE B KOMPLET)
- feat: push-to-talk mic (Web Speech, da-DK) + TTS-knap på assistant-rækker
- Governance bevaret: transskriptioner gennem governed ask; audit uden tekst
- rooms-voice 3/3; scope 17/17

## 2026-09-05 — B3: knowledge-citations i rooms ask
- feat: useKnowledge → search top-3 → [KB]-kontekst; citations i response+envelope; cite() registreret
- FIX: 18-knowledge readJson ReferenceError (POST /v2/knowledge virkede aldrig)
- b3 2/2; knowledge 6/6; ask 5/5

## 2026-09-05 — C4: session-branching (BØLGE C KOMPLET)
- feat: POST /v2/chat/llm/branch — forkast fra index/'latest' til navngiven session
- Operator-only; governance-neutral (samme propose-pipeline)
- UI: branch-knap; roomSession skiftes pr. branch
- branch 3/3; panel+a4 17/17

## 2026-09-05 — C3: human-in-the-loop kort (HIL)
- feat: GET /v2/rooms/:id/hil — approvals + need-you + takeovers som actionable cards
- UI: HIL-kort i Mission-tab; TDZ-fix (pendingReply module-scope); md createTextNode-guard
- hil 3/3, panel 11/11, a4 3/3 — chat-scope grøn

## 2026-09-05 — C2: delegation-badge i chat + test-isolation
- feat: handoff-rækker viser from→target + dybde inline
- FIX: 4 testfiler delte data/rooms.json (TG_ROOMS_FILE default) → flaky; nu isolerede tmp-filer
- 4×20/20 grønne i træk

## 2026-09-05 — C1: live mission-thread (Mission-tab)
- feat: GET /v2/rooms/:id/missiontimeline — room+workflow+works i én timeline
- UI: Mission-tab (lazy); summaries metadata-only (secret-hygiene)
- 2/2 nye tests; scope 43/0/1

## 2026-09-05 — B1: fil-upload i rooms (attach → artifacts)
- feat: POST /v2/rooms/:id/attach — artifact + attachment-envelope (metadata-only)
- groups.js: whitelistet attachment-body; UI attach-knap + attachment-kort
- 3/3 nye tests; scope 41/0/1

## 2026-09-05 — chat A4: besked-handlinger (BØLGE A KOMPLET)
- feat: replyTo gennem ask-mount (begge envelopes); reply/copy-knapper i tråden
- regenerate = reply på assistant-besked → ask igen
- chat-scope 66 pass / 0 fail / 1 skip (win32 0600)
- A1 65d6523 · A2 aabac66 · A3 40a55d6 · A4 denne

## 2026-09-05 — chat A3: markdown-renderer (0 deps, XSS-sikker)
- feat: app/lib/md.js — kodeblokke m. copy, inline formatting, lister, tabeller, links
- assistant-beskeder i rooms renderes som markdown (textContent-only)
- md 8/8 + panel/rooms 24/24 grønne

## 2026-09-05 — chat A2: SSE token-streaming (governed done)
- feat: POST /v2/chat/llm/stream — deltas display-only; done-event bærer governed verdict
- chatStream-udvidelsespunkt på brain; fallback = én done {fallback:true}
- UI: ask streamer live; commit aabac66
- tests/chat-llm-stream.test.js 4/4; chat-scope 55/0/1

## 2026-09-05 — chat A1: rooms ask (governed LLM i tråden)
- feat: POST /v2/rooms/:id/ask — question + answer som A2A envelopes
- assistant-kind (additiv): proposal-metadata (tool+decision, ingen args) + fallback-flag
- Samme governed brain som /v2/chat/llm; room-namespaced sessions
- Gateway: additiv 'mounts'-param til object-mounts i tests
- UI: ask-knap + proposal-kort i tråden (textContent-only)
- tests/rooms-ask.test.js 5/5; chat-scope 51/0/1 (win32 0600 skip, pre-existing)
- commit 65d6523 (direkte main, sammenhængende med sessionens PR-mønster)

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
## 2026-09-05 — WORKS proxy mount
- feat: /v2/executions read-only proxy through TG auth
- server.js: unified router with fnMounts opt-in wiring
- 4 works-proxy tests green; 102 graph/UI/stores tests green
- PR #19 merged → main 69f8f30

## 2026-09-05 — Executions panel (WORKS in TG SPA)
- feat: read-only WORKS panel consuming /v2/executions proxy
- core.js WORK domain + index.html + style.css exec-* tokens
- 26/26 tests green
- PR #21 merged → main bde419d
- First cross-repo UI integration — WORKS visible in TG console

## 2026-09-05 — authority proxy mount (AIE in TG)
- feat: /v2/authority + /v2/authority/:kind read-only operator-only proxy
- aie_authority_bridge.py reads PersistentState in read-only URI mode
- 7 tests green; 55 graph/UI/works tests green
- committed → main e7b5209

## 2026-09-05 — Authority panel (AIE in TG SPA)
- feat: read-only authority panel consuming /v2/authority proxy
- 5 kind tabs; lease revocation/depth/budget badges; counts summary
- 26/26 tests green
- PR #23 merged → main 02ba7dd
- Second cross-repo UI integration — AIE authority visible in TG console
