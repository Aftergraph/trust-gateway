---
status: current
date: 2026-09-02
audience: operators, auditors
authority: derived directly from src/gateway/** as of 264319d; enforced by tests/standards.test.js
---

# TRANSPARENCY.md — what every module does, stores, and writes to the record

The gateway has no hidden state. Every module's HTTP surface, audit-event
types, and on-disk file are listed here, with the exact way an operator
inspects each. `tests/standards.test.js` programmatically extracts every
`{type: '…'}` string from `src/gateway/**` and fails if the event table
below is missing one.

**How an operator reads the audit record (applies to everything below):**

- `GET /v1/audit?since=N` — paginated entries with head + live verify status
  (auth: bearer).
- `GET /v2/events?token=…` — live SSE stream of every sealed entry
  (`event: audit`) plus pending-approval frames.
- `GET /v1/audit/verify` — full chain verification `{ok, length, head, chainId}`.
- `GET /v2/search?q=…&token=…` — full-text search over audit payloads.
- `GET /` — operator console (dashboard); `GET /healthz` — one-line chain state.
- Direct files: everything under `data/` (gitignored runtime dir).

## Modules

### `hash-chain.js` — tamper-evident chain core
- **Endpoints:** none (library). Used by everything else.
- **Audit events:** `genesis` (chain seed, per-instance `chainId`).
- **Storage:** embedded in the audit file/db below; verify via `GET /v1/audit/verify`.
- **Inspect:** `node -e "console.log(require('./src/gateway/hash-chain').HashChain.fromJSONL?.name)"`
  is not needed — use the HTTP verify endpoint or read `data/audit.jsonl` directly
  (one JSON entry per line).

### `sql-chain.js` — v2 chain storage (node:sqlite)
- **Endpoints:** none (library). Same surface as HashChain (append/verify/since/head).
- **Audit events:** `genesis` (seeded into `chain_entries`).
- **Storage:** `data/gateway.db` (single sqlite file; `DB_FILE` env override).
- **Inspect:** `GET /v1/audit/verify`; or
  `node -e "const{DatabaseSync}=require('node:sqlite');const db=new DatabaseSync(process.env.DB_FILE||'data/gateway.db');console.log(db.prepare('SELECT seq,ts,payload FROM chain_entries ORDER BY seq DESC LIMIT 5').all())"`.

### `policy.js` — fail-closed classifier
- **Endpoints:** none (library). Runs inside every action decision.
- **Audit events:** none of its own — it produces decisions recorded by
  `server.js` as `action_decision`.
- **Inspect:** audit entries of type `action_decision` carry
  `{bot, tool, class, decision, reason}`.

### `approvals.js` — human approvals with TTL
- **Endpoints:** `GET /v1/approvals`, `POST /v1/approvals/:id/approve|deny`
  (in `server.js`), `POST /v2/rooms/:id/messages` room flows.
- **Audit events:** produced by callers — `approval_requested`,
  `approval_resolved`, `approval_forbidden`, `action_executed_after_approval`.
- **Storage:** `data/approvals.json` (atomic tmp+rename, 0600; `APPROVALS_FILE` env override).
- **Inspect:** `GET /v1/approvals` (pending with TTL); resolved approvals are
  audit entries (`approval_resolved`).

### `server.js` — HTTP API + auth + write-ahead audit
- **Endpoints:** `GET /` (console/SPA when staticDir set), `GET /healthz`
  (no auth), `POST /v1/actions`, `GET /v1/approvals`,
  `GET /v1/audit?since=`, `GET /v1/audit/verify`,
  `POST /v1/approvals/:id/approve|deny`, `GET /home` marketing (public).
- **Audit events:** `auth_rejected`, `action_decision`, `action_executed`,
  `action_executed_after_approval`, `approval_requested`, `approval_resolved`,
  `approval_forbidden`.
- **Inspect:** the `/v1/*` endpoints above; failed auths are visible as
  `auth_rejected` entries with the path.

### `client.js` — zero-dependency bot SDK
- **Endpoints:** none (outbound SDK wrapping the `/v1/*` API).
- **Audit events:** none — it calls the API like any bot; effects are audited server-side.
- **Inspect:** `example/bot.js`, `example/console.js` show its usage.

### `http-mounts.js` — mount loader
- **Endpoints:** none itself; loads `src/gateway/mounts/*.js` into the server.
- **Audit events:** none.
- **Inspect:** `ls src/gateway/mounts/` is the live route table; each file
  declares `{name, method, path, auth}`.

### `disk-audit.js` — JSONL write-ahead log
- **Endpoints:** none (library).
- **Audit events:** none of its own; it persists whatever `server.js._audit` seals.
- **Storage:** `data/audit.jsonl` (append-only, one entry per line; `AUDIT_FILE` env override).
- **Inspect:** `tail -5 data/audit.jsonl` or `jq -r .payload.type data/audit.jsonl | sort | uniq -c`.

### `chat.js` + `chat-singleton.js` — deterministic governed chat
- **Endpoints:** `POST /v2/chat` {session, message} (mount `20-chat.js`, bearer).
- **Audit events:** `chat_action`, `chat_action_executed`, `approval_requested`.
- **Storage:** sessions are in-memory (ephemeral by design in this slice);
  every proposal/seal is in the chain.
- **Inspect:** `GET /v2/search?q=chat_action&token=…`.

### `llm-brain.js` + mount `22-chat-llm.js` — LLM chat brain
- **Endpoints:** `POST /v2/chat/llm` {session, message} (bearer). Degrades to
  `{fallback:true}` when `TG_LLM_*` unset.
- **Audit events:** `chat_action`, `chat_action_executed`, `approval_requested`.
- **Storage:** none beyond the chain; `TG_LLM_KEY` never leaves env.
- **Inspect:** audit search on `chat_action` (payload carries `source: 'llm'`).

### `events.js` + mount `10-events.js` — SSE hub
- **Endpoints:** `GET /v2/events?token=…` (auth: query — EventSource can't
  set headers); broadcasts `event: audit`, `pending`, `artifact`, `computer`.
- **Audit events:** none of its own (it distributes everyone else's).
- **Inspect:** open the stream with an operator token and watch frames; the
  dashboard is a consumer of the same feed.

### `search.js` + mount `10-search.js` — audit full-text search
- **Endpoints:** `GET /v2/search?q=…&token=…` (auth: query).
- **Audit events:** none (read-only over the chain).
- **Inspect:** the endpoint itself; hits are `{seq, ts, hash, payload}`.

### mount `15-stats.js` — `GET /v2/stats` (bearer)
- Counts: `{entries, lastTs, pendingCount, bots:{name:count}}`. Read-only.

### mount `16-bots.js` — `GET /v2/bots` (bearer)
- Projects `{name, role, capabilities}` only — no tokens ever. Read-only.

### mount `00-placeholder.js` — `GET /v2/ping` (no auth)
- Health-canary for the mount system itself. Audits nothing.

### `groups.js` + mount `25-groups.js` — rooms, A2A fan-out, handoffs
- **Endpoints:** `GET|POST /v2/rooms`, `GET|DELETE /v2/rooms/:id`,
  `POST /v2/rooms/:id/messages` (bearer; round/turn caps enforced).
- **Audit events:** `room_created`, `room_message`, `room_handoff`,
  `room_limit_hit`, `room_deleted`, plus action-loop events
  (`action_decision`, `action_executed`, `approval_requested`).
- **Storage:** `data/rooms.json` (atomic, 0600; `TG_ROOMS_FILE` env override).
- **Inspect:** `GET /v2/rooms`, `GET /v2/rooms/:id` (transcript); file via jq.

### `agent-store.js` + mount `31-agents.js` — custom-agent builder, profiles
- **Endpoints:** `POST|GET /v2/agents`, `GET|PUT|DELETE /v2/agents/:name`,
  `GET|PUT /v2/profiles/:who` (bearer; deletes/writes RBAC-gated).
- **Audit events:** `profile_updated`, `approval_forbidden` (every denied
  privileged attempt is recorded).
- **Storage:** `data/agents.json` (atomic, 0600; `TG_DATA_DIR` env override).
- **Inspect:** `GET /v2/agents`, `GET /v2/profiles/:who` (operator sees any).

### `plugins.js` + mount `35-plugins.js` — plugin/MCP/skills hub, secrets
- **Endpoints:** `GET|POST /v2/plugins`, `GET /v2/plugins/:id`,
  `POST /v2/plugins/:id/enable|disable`, `DELETE /v2/plugins/:id`, plus
  `/v2/skills`, `/v2/mcp` sub-surfaces (bearer; writes RBAC-gated,
  `plugins_forbidden` on violation).
- **Audit events:** `plugin_installed`, `plugin_rejected`, `plugin_enabled`,
  `plugin_disabled`, `plugin_uninstalled`, `mcp_registered`, `mcp_rejected`,
  `mcp_unregistered`, `secret_configured`, `secret_removed`.
- **Storage:** `data/plugins.json` (state, atomic 0600; `TG_PLUGINS_DATA_DIR`
  env override) and `data/modules/<id>/` (installed copies; source dir
  `modules/`).
- **Inspect:** `GET /v2/plugins`; secrets show name+length only — never values.

### `artifacts.js` + mount `40-artifacts.js` — workforce artifacts
- **Endpoints:** `POST|GET /v2/artifacts`, `GET|PUT /v2/artifacts/:id`,
  `GET /v2/artifacts/:id/stream` (SSE follow-along). Auth in-handler:
  Bearer, `?token=` for SSE.
- **Audit events:** `artifact_created`, `artifact_updated`,
  `artifact_update_denied`, `auth_rejected`.
- **Storage:** `data/artifacts.json` (atomic, 0600; `TG_ARTIFACTS_FILE` env override).
- **Inspect:** `GET /v2/artifacts?kind=&bot=`; the stream replays all versions.

### `computer.js` + mount `42-computer.js` — live computer sessions
- **Endpoints:** `POST|GET /v2/computer`, `GET /v2/computer/:id`,
  `POST /v2/computer/:id/frames`, `POST /v2/computer/:id/control`
  (operator-only), `GET /v2/computer/:id/stream` (SSE). Auth in-handler.
- **Audit events:** `computer_session_created`, `computer_frame`,
  `computer_frame_denied`, `computer_control_denied`, `computer_state_changed`,
  `control_taken`, `control_released`, `auth_rejected`.
- **Storage:** `data/computer.json` (atomic, 0600; `TG_COMPUTER_FILE` env override).
- **Inspect:** `GET /v2/computer/:id` returns session + frames + chain
  verification for that session.

### `providers.js` + `providers-singleton.js` + mount `45-providers.js`
- **Endpoints:** `GET /v2/providers` (directory, allow-list projection — no
  key material), `GET /v2/providers/models`, `POST /v2/providers/plan`
  ({task, preferFree}), `POST /v2/providers/probe` (explicit, non-blocking).
- **Audit events:** `provider_plan`, `provider_probe`.
- **Storage:** `data/providers.json` (atomic, 0600, fail-closed on corrupt).
- **Inspect:** `GET /v2/providers?probe=<n>`; lane notes state real
  constraints (free lanes, exhausted paid lanes).

### `continuity.js` + mount `50-continuity.js` — goals, slash, loops
- **Endpoints:** `/v2/goals` (create/list), `/v2/goals/:id/step|resume`,
  pause/clear/complete via the same surface, `/v2/slash` (bearer).
- **Audit events:** `goal_added`, `goal_stepped`, `goal_step_denied`,
  `goal_step_awaiting_approval`, `goal_paused`, `goal_resumed`,
  `goal_cleared`, `goal_completed`, `goal_loop_started`,
  `goal_loop_stopped`, `slash_run`.
- **Storage:** `data/continuity.json` (atomic, 0600; `TG_CONTINUITY_FILE` env override).
- **Inspect:** goal listing endpoint; every step/decision is an audit entry.

### `selfrepair.js` + mount `51-repair.js` — tamper diagnosis
- **Endpoints:** `GET /v2/repair/diagnose` (bearer). On tamper: `503` +
  quarantine snapshot.
- **Audit events:** `selfrepair_diagnosed`.
- **Storage:** `data/quarantine-<ts>.json` (snapshot of suspect tail, atomic 0600).
- **Inspect:** the endpoint; quarantined snapshots are plain JSON you can diff.

### `rbac.js` — approval/operator gate
- **Endpoints:** none (library). `canApprove(bot)` used by every write surface.
- **Audit events:** refusals appear as `approval_forbidden` /
  `plugins_forbidden` in the caller's audit.
- **Inspect:** audit search `q=forbidden`.

### `dispatcher.js` — jailed filesystem dispatch
- **Endpoints:** none directly; invoked by `gw.dispatch` for allowed actions
  when the gateway runs with `--dispatch`.
- **Audit events:** execution results appear as `action_executed` /
  `action_executed_after_approval` (server-side).
- **Storage:** operates only inside `data/bots/<name>/` jails (per-bot).
- **Inspect:** audit entries for every dispatch; jail contents per bot dir.

## Full audit-event table

55 event types emitted from `src/gateway/**`. Extraction rule: every string
matched by `{type: '…'}` (including the `enabled ? 'a' : 'b'` ternary in
plugins.js) across all files under `src/gateway/`.

| # | type | emitters |
|---|---|---|
| 1 | `action_decision` | server.js, groups.js |
| 2 | `action_executed` | server.js, groups.js |
| 3 | `action_executed_after_approval` | server.js |
| 4 | `approval_forbidden` | server.js, mounts/31-agents.js |
| 5 | `approval_requested` | server.js, chat.js, llm-brain.js, groups.js |
| 6 | `approval_resolved` | server.js |
| 7 | `artifact_created` | mounts/40-artifacts.js |
| 8 | `artifact_update_denied` | mounts/40-artifacts.js |
| 9 | `artifact_updated` | mounts/40-artifacts.js |
| 10 | `auth_rejected` | server.js, mounts/40-artifacts.js, mounts/42-computer.js |
| 11 | `chat_action` | chat.js, llm-brain.js |
| 12 | `chat_action_executed` | chat.js, llm-brain.js |
| 13 | `computer_control_denied` | mounts/42-computer.js |
| 14 | `computer_frame` | mounts/42-computer.js |
| 15 | `computer_frame_denied` | mounts/42-computer.js |
| 16 | `computer_session_created` | mounts/42-computer.js |
| 17 | `computer_state_changed` | mounts/42-computer.js |
| 18 | `control_released` | mounts/42-computer.js |
| 19 | `control_taken` | mounts/42-computer.js |
| 20 | `genesis` | hash-chain.js, sql-chain.js |
| 21 | `goal_added` | continuity.js |
| 22 | `goal_cleared` | continuity.js |
| 23 | `goal_completed` | continuity.js |
| 24 | `goal_loop_started` | continuity.js |
| 25 | `goal_loop_stopped` | continuity.js |
| 26 | `goal_paused` | continuity.js |
| 27 | `goal_resumed` | continuity.js |
| 28 | `goal_step_awaiting_approval` | continuity.js |
| 29 | `goal_step_denied` | continuity.js |
| 30 | `goal_stepped` | continuity.js |
| 31 | `mcp_registered` | plugins.js |
| 32 | `mcp_rejected` | plugins.js |
| 33 | `mcp_unregistered` | plugins.js |
| 34 | `plugin_disabled` | plugins.js |
| 35 | `plugin_enabled` | plugins.js |
| 36 | `plugin_installed` | plugins.js |
| 37 | `plugin_rejected` | plugins.js |
| 38 | `plugin_uninstalled` | plugins.js |
| 39 | `plugins_forbidden` | mounts/35-plugins.js |
| 40 | `profile_updated` | mounts/31-agents.js |
| 41 | `provider_plan` | mounts/45-providers.js |
| 42 | `provider_probe` | mounts/45-providers.js |
| 43 | `room_created` | groups.js |
| 44 | `room_deleted` | groups.js |
| 45 | `room_handoff` | groups.js |
| 46 | `room_limit_hit` | groups.js |
| 47 | `room_message` | groups.js |
| 48 | `secret_configured` | plugins.js |
| 49 | `secret_removed` | plugins.js |
| 50 | `selfrepair_diagnosed` | selfrepair.js |
| 51 | `slash_run` | continuity.js |
| 52 | `harness_build` | mounts/55-harness.js (wave B executors, merged after doc extraction) |
| 53 | `harness_result` | mounts/55-harness.js |
| 54 | `worktree_snapshot` | mounts/55-harness.js |
| 55 | `worktree_remove` | mounts/55-harness.js |
| 56 | `voice_stt` | mounts/60-voice.js (wave C, merged after doc extraction) |
| 57 | `voice_tts` | mounts/60-voice.js (wave C, merged after doc extraction) |

## Documented exceptions

The test compares the table above against a programmatic extraction over
`src/gateway/**/*.js`. Two classes of known exceptions are declared here:

1. **`genesis`** (rows 20): emitted by the chain layers
   (`hash-chain.js` line 33, `sql-chain.js` line 59) at chain-seed time —
   not from a request handler, but it is a real audit payload type and is
   listed. It is kept in the table (not skipped) precisely so the test can
   assert nothing is invented or missing.
2. **`auth_rejected`** (row 10): emitted from three surfaces (server runner
   auth, artifacts, computer) — one type, multiple emitters, listed once.

No other exceptions exist. If the extraction finds a `{type: '…'}` string
that is not in the table (or the table lists something the code no longer
emits), `tests/standards.test.js` fails — update both in the same commit.