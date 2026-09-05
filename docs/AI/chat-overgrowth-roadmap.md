# CHAT-OVERGROWTH ROADMAP v1 — 2026-09-05

Mål: TG's chat-oplevelse skal matche og overgå Hermes Desktop / Claude / ChatGPT —
uden at gå på kompromis med governance-DNA'et (proposal → approval → sealed audit).
Alt bygger på primitives der ALLEREDE findes (232 routes, llm-brain 332L, llm-loop
491L, rooms A2A, SSE hub, approvals, workflows, knowledge, voice, artifacts).

## Facit: 12 slices i 4 bølger

### BØLGE A — Chat-kernen (gør chatten til en chat)
| # | Slice | Bygger på | Overgår konkurrenterne med |
|---|---|---|---|
| A1 | Rooms ↔ LLM-kobling: "spørg hjernen" i rooms-tråden → POST /v2/chat/llm/user; svar + proposal + approval-status renderes inline som A2A envelope (kind:'assistant') | rooms A2A + 103-chat-user + approvals | Modellen kan ALDRIG handle — dens forslag vises som godkendelseskort i selve tråden |
| A2 | Token-streaming: llm-brain v2 med upstream SSE-parse + ny mount /v2/chat/llm/stream (SSE down); UI renderer incrementelt | llm-brain + SSE hub | Streaming MED approval-gate — ChatGPT/Claude har ikke det |
| A3 | Markdown-renderer (~200L, ingen deps): kodeblokke m. copy-knap, tabeller, lister, inline-code; XSS-sikker via DOM/textContent | app/panels/rooms.js | Kommer i A1/A2 kortene |
| A4 | Besked-handlinger: retry/regenerate, edit-and-resend, copy, reply-to (replyTo findes allerede i envelope-skemaet) | rooms store | — |

### BØLGE B — Rig indhold og input
| # | Slice | Bygger på | Overgår med |
|---|---|---|---|
| B1 | Fil-upload i rooms: multipart → artifacts store; preview i tråden (billeder), attachment-kort til artifacts-panel | 40-artifacts + /v2/artifacts/:id/stream | Chat + artifacts er SAMME flow (Claude har adskilt) |
| B2 | Voice: push-to-talk i compose → /v2/voice/stt → LLM → /v2/voice/tts afspilning | 60-voice | Governance-venlig voice (transskription audits) |
| B3 | Knowledge-citations i svar: LLM-svar kan citere knowledge-sources via cite(id) → renderes som klikbare kildekort | knowledge.js + cite() | Svar med verificerbare, tenant-scoped kilder |

### BØLGE C — Agent-oplevelsen (det ingen andre har)
| # | Slice | Bygger på | Overgår med |
|---|---|---|---|
| C1 | Live mission-thread: /v2/proposals + /v2/workflows knyttes til rooms — mission-lifecycle (proposal → WORKS Work → evidence) renderes som timeline i tråden | 23-missions + 26-workflows + 131-works-proxy | ChatGPT/Claude viser ikke execution; TG viser hele mission-kæden live |
| C2 | Delegation-visualisering i chat: delegation-chain hentes ved handoff-beskeder (kind:'handoff') → mini-træ i beskedkortet | 27-delegation-chain + rooms panel | A2A-delegation som førsteklasses chat-indhold |
| C3 | Needs-You + takeover i tråden: /v2/need-you/now + /v2/takeover som interaktive kort med resolve/hand-back knapper | 08-need-you + 33-takeover | Human-in-the-loop som chat-hændelse, ikke dashboard |
| C4 | Session-branching: forgrenede LLM-sessioner pr. room (session-navnespacing findes i 103-chat-user) → forgrenings-træ à la Claude Projects, men governance-sealed | chat-singleton + 103 | — |

### BØLGE D — Multi-platform polish
| # | Slice | Bygger på | Overgår med |
|---|---|---|---|
| D1 | Mobil: chat-tråd fuldskærm, bottom-nav, compose fastgjort til tastatur, safe-area | responsive.css + PWA (manifest+sw findes) | Installérbar PWA MED approvals — godkend missioner fra telefonen |
| D2 | Push/unread: Telegram-adapteren kobles til approval-pending + need-you events (allerede outbound) + badges i SPA | telegram-adapter + SSE | — |
| D3 | Tema/tetthed: dark/light, kompaktdrift, keyboard-shortcuts (/, cmd-k command palette) | style.css | — |

## STATUS 2026-09-05 — 11/12 slices LANDET
- BØLGE A: 4/4 ✅ (A1 65d6523 · A2 aabac66 · A3 40a55d6 · A4 86351ae)
- BØLGE B: 3/3 ✅ (B1 36a97e0 · B2 fdcc3fd · B3 c6a409a)
- BØLGE C: 4/4 ✅ (C1 1bdfb2c · C2 29a7e90 · C3 afa2075 · C4 45a3e3c)
- BØLGE D: 3/3 ✅ (D1 b4-commit · D2 b4bfae4 · D3 1149961)
- Chat-scope: 84 tests grønne (batch1 17 + batch2 67/0/1)
- Bonus-fixes: 18-knowledge readJson-bug (POST virkede aldrig), test-isolation
  (TG_ROOMS_FILE), TDZ i messageRow, md createTextNode-guard, C1 UI-tab-restore

## Ikke-mål (bevidst)
- Ingen innerHTML-rendering (XSS-loven) — alt DOM/textContent.
- Ingen LLM auto-execution — modellen foreslår, mennesket (eller RBAC-reglen) godkender.
- Ingen nye tunge deps — stdlib + eksisterende mounts.

## Rækkefølge og bevis-byrde
A1 → A2 → A3 → A4 (BØLGE A komplet = "det er en chat") → B1 → C1 → C3 (de
tre der gør TG unik) → resten. Hver slice: TDD rød→grøn, Tier C-suite grøn,
PR → squash-merge, handoff opdateres.

## Primitives-inventar (verificeret 2026-09-05)
- TG: llm-brain 332L (stream-klar), llm-loop 491L, chat mounts x5 (/v2/chat,
  /llm, /llm/deep, /llm/preview, /llm/user), rooms A2A (groups.js 378L),
  SSE hub (server.js), approvals (128L) + batch/metrics, need-you, takeover,
  workflows (223L), missions/proposals, knowledge+cite, semantic search,
  voice stt/tts, artifacts+stream, hash-chain audit, 232 /v2-routes total.
- AIE: gateway HTTP (/leases /admissions /missions /revocations /evidence),
  engine 277L, persistent_state 284L.
- WORKS: 14 Go services (api, evidence, provenance, runner, webhook...),
  workgraph-pakker, enrollment-JWS.

## FULDSTACK-BØLGE E+F+G (2026-09-05, efter roadmap-komplet)
- E1 mission.create (c12f53f) · E2 TH-12 verificeret · E3 missions-panel (ee4bc71) · E4 lease-visning (5c84a45)
- F1 mission-detail drawer (7e8240d) · F2 integrity-badge (59a488e) · F3 evidence-badges (a5b1683)
- G1 WORKS Evidence.Hash (7c77b2f, CI grøn) · G2 Seal ved alle creation-paths (2d94fad, CI grøn)
- Næste: G3 WORKS-side UI hash-badge · unsealed/tampered visning i TG drawer
