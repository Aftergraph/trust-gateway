---
status: approved-for-build
date: 2026-09-02
author: Hermes (AVC operator)
scope: v2 slice 1 of 3 (persistence + dashboard + chat-core). Chat LLM-brain and orchestration are later slices.
---

# Trust Gateway v2 — Persistence, Events, Dashboard, Chat-core

## Why
v1.x serves a static HTML snapshot and stores audit as JSONL + approvals as JSON.
v2 turns the gateway into a *product surface*: live event stream, a real single-page
operator console, and a chat loop where a human talks to the workforce and every
proposed action flows through policy → approval → jailed dispatch → sealed audit.

## Decisions (locked)
1. **Storage = `node:sqlite` (built-in Node 24, DatabaseSync)** — zero deps, sync,
   single file `data/gateway.db`. Verified working on this host.
2. **Migration (a): carry live history over.** `bin/migrate-v2.js` imports
   `audit.jsonl` + `approvals.json` into SQL and *refuses* unless the imported
   chain verifies AND head hash equals the JSONL head hash. Fail closed.
3. **Chain interface unchanged.** `SqlChain` exposes the same surface as HashChain
   (append/verify/since/head/entries/chainId) so Gateway code does not fork.
   Entries are lazily loaded; verification re-hashes over SQL.
4. **Events = Server-Sent Events** (`GET /v2/events`). No WebSocket dependency;
   SSE is one-way server→client, exactly what audit/pending feeds need, auto-reconnect
   built into EventSource. Auth via `?token=` (browser EventSource cannot set headers).
5. **Chat = deterministic action-planner (no LLM in this slice).** `POST /v2/chat`
   with `{session, message}`. A small intent table maps phrases to proposed tools
   ("delete X" → fs.delete:X → needs_approval card). LLM brain is slice 2.
   The point of v2.0 chat is the *governed loop*, visible in UI: proposal →
   approval card → seal. Not model quality.
6. **Dashboard = self-contained SPA** at `GET /` (replaces current dashboardHtml):
   dark, mono aesthetic of v1, three panes (live audit stream | pending approvals
   with approve/deny buttons | bots+jail status), EventSource-driven, zero framework.
7. **Pre-wired mount skeleton** (done by orchestrator BEFORE agents start):
   `http-mounts.js` exposes router table; agents add files, never edit server.js.

## v2 API contract (all JSON unless noted; Bearer or ?token= auth)
- `GET  /v2/events?token=…`                SSE; events: `audit` (new sealed entry),
                                            `pending` (approval created/resolved)
- `GET  /v2/bots`                          → {bots:[{name,role,capabilities}]}  (no tokens ever)
- `GET  /v2/stats`                         → {entries, lastTs, pendingCount, bots:{name:count}}
- `POST /v2/chat` {session, message}       → {reply, actions:[{id,tool,decision,reason,approvalId?}]}
- `GET  /v2/search?q=shell&token=…`        FTS5 over audit payloads → {hits:[entry…]}
- v1 endpoints unchanged (compat).

## Data model (gateway.db)
```
chain_entries(seq INTEGER PRIMARY KEY, ts INTEGER NOT NULL,
              prev_hash TEXT NOT NULL, hash TEXT NOT NULL UNIQUE,
              payload TEXT NOT NULL)            -- canonical JSON as stored
chain_meta(k TEXT PRIMARY KEY, v TEXT)          -- chainId, schema_version
approvals(id TEXT PRIMARY KEY, bot TEXT, tool TEXT, args TEXT,
          status TEXT, created_at INT, expires_at INT,
          resolved_by TEXT, resolved_at INT)
sessions(name TEXT PRIMARY KEY, created_at INT) -- chat sessions
```
FTS5: `chain_fts(payload, tool, bot)` content-table index; rebuilt on migrate.

## Files and ownership (5 parallel agents; conflict-free by construction)
- **A1 data:** `src/gateway/sql-chain.js`, `bin/migrate-v2.js`,
  `tests/sql-chain.test.js`, `tests/migrate.test.js`
- **A2 events:** `src/gateway/events.js` (SSE hub),
  edits ONLY `http-mounts.js` rows it owns (events, stats, bots),
  `tests/events.test.js`
- **A3 dashboard:** `app/index.html`, `app/app.js`, `app/style.css` (pure static;
  served by pre-wired static mount), `tests/app.test.js` (file existence + HTML sanity)
- **A4 chat:** `src/gateway/chat.js` (planner + session store on SqlChain-style
  plain SQL), edits ONLY `http-mounts.js` rows it owns (chat), `tests/chat.test.js`
- **A5 search+polish:** FTS in A1's schema (coordination: A1 creates it; A5 writes
  `src/gateway/search.js` + `tests/search.test.js`), README v2 section, demo
  `example/console.js` (drives chat+approve via SDK)

## Convergence rules (orchestrator = Hermes, after agents finish)
- Merge A1→master first (others assume its schema; they build against contract).
- Run full suite; fix signature drift exactly like the 3-arg dispatch round.
- Restart gateway; E2E: migrate 91+ entries → open dashboard on Lenovo → chat
  propose → approve → SSE seal appears in stream without reload.

## Non-goals (later slices)
LLM chat brain; multi-agent orchestrator; RBAC per-endpoint (operator-only SSE read
later); TLS; container isolation.