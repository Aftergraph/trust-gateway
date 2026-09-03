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

### `llm-loop.js` + mount `23-chat-llm-live.js` — multi-iteration LLM tool-call loop
|- **Endpoints:** `POST /v2/chat/llm/deep` {session, message, bot?} (bearer).
  Up to 3 iterations; allowed-tools list is built from
  `ROLE_CAPABILITIES + classify` (read/write classes only — destructive
  and secret never make it into the prompt). Reuses the same brain as
  `llm-brain.js` via `getBrain(gw)`. Degrades to `{fallback:true, reply:
  'llm not configured'}` when the brain is unset.
||- **Audit events:** `chat_action`, `chat_action_executed`,
  `approval_requested`, `observation_scanned` — same types as the
  single-turn brain, with `source: 'llm-live'` to distinguish the
  loop-driven path. `observation_scanned` carries `{tool, hits, chars}`
  metadata only (scanned text is never stored). Parked approvals
  return `{reply, pending_approval:{id,tool}, iterations}`. External tool
  results (web.fetch, web.extract, harness.run, adapter probes) are
  quarantined and scanned before reaching the brain;
  `observation_scanned` records metadata only (tool, hits, chars).
- **Tool execution:** routed through `gw._run(bot, tool, args)` — the
  SAME path the deterministic ChatPlanner and the v1 `_postAction`
  handler use. No second dispatch route.
|- **Inspect:** audit search `q=chat_action source:llm-live`.
|- **Observation formatting (D4):** external tool results (web.fetch,
  web.extract, adapter probes, harness.run) are quarantined via
  `quarantineWrap` and scanned via `scanForInjection` before entering
  the brain. A `[security: N hits]` integrity notice is prepended when
  injection patterns are detected. Internal tool results pass through
  raw. The response carries `observationsTrusted: true`.

### `runs.js` + mount `96-runs.js` — first-class Run/Step objects (wave F)
- **Endpoints:** `GET /v2/runs?bot=&state=&goalId=&limit=` (bearer; default
  last 50, cap 200), `GET /v2/runs/:id` (bearer; run + full step list +
  recent chain refs for provenance), `POST /v2/runs/:id/cancel`
  (operator via `canApprove()`, or the bot that owns the run).
- **Audit events:** `run_started`, `run_completed`, `run_paused` — the three
  cancellable-state transitions only. Per-step events deliberately flow
  through the existing `chat_action` / `chat_action_executed` /
  `approval_requested` entries; no per-step audit types exist. A denied
  non-operator cancel attempt reuses `approval_forbidden`.
- **Storage:** `data/runs.json` — `{ <runId>: Run, …, "steps": { <stepId>:
  Step } }` (atomic tmp+rename, 0600, fail-closed on corrupt load; run ids
  `r_<8hex>` can never collide with the reserved `steps` key;
  `TG_RUNS_FILE` env override) and `data/run-by-goal.json` —
  `{ <goalId>: [runId, …] }` index for the future Graph view.
- **Payload hygiene:** Steps carry `argsDigest`/`resultDigest` =
  `sha256(plaintext)[:16]` — tool args and results are NEVER persisted;
  digests let humans correlate against the audit chain. FIFO cap: 200 runs,
  oldest evicted with its steps (and goal-index entries).
- **Inspect:** `GET /v2/runs/:id` (steps + `{seq, ts, type, hash}` chain
  refs); the file via jq; runs are written by `deepTurn` (engine
  `llm-loop`), the single-turn brain `propose()` (engine `planner`), and
  the `harness.run` executor (engine `harness`).

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

### mount `92-providers-live.js` — live provider observability (D5)
- **Endpoints:** `GET /v2/providers/live` (bearer; operator-only).
- **Audit events:** `provider_live_access_denied` (worker attempt),
  `provider_live_probed` (successful probe by operator).
- **Storage:** none (ephemeral probe results).
- **Inspect:** the endpoint returns `{providers: [{name, ok, httpStatus?, detail, ms}]}`.

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

### `playground.js` + mount `80-playground.js` — safe in-app code lab (C6)
- **Endpoints:** `POST /v2/playground/run` (bearer). JS runs in jailed scratch;
  HTML returns `{preview:'sandboxed'}` only.
- **Audit events:** `playground_run` ({bot, lang, bytes, exitCode, timedOut} —
  never code content or stdout bodies).
- **Storage:** scratch files under `data/bots/<bot>/playground/` (ephemeral,
  cleaned by timeout/exit).
- **Containment:** jail-resolved paths, scrubbed env (PATH/HOME/NODE_ENV only),
  hard timeout → SIGKILL. Residual: same-user process can access fs/network;
  hardened container is the real boundary (later slice).
- **Inspect:** audit search `q=playground_run`; no artifact store integration.

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

### `users.js` + `sessions.js` + mount `101-auth.js` — human accounts + scrypt sessions (FS-A1)
- **Endpoints:** `POST /v2/auth/register` {email, password, display_name?}
  (pw ≥10 chars, 5/min/IP), `POST /v2/auth/login` (10/min/IP, generic
  'invalid credentials' — no account enumeration, dummy scrypt burn keeps
  timing flat), `POST /v2/auth/logout`, `GET /v2/auth/me` → {user, bot:null}.
- **Audit events:** `user_registered` ({userId, role}), `user_login_ok`
  ({userId}), `user_login_failed` ({reason}), `user_logout` ({userId}).
- **Storage:** `data/users.json` (atomic 0600, fail-closed on corrupt;
  `TG_USERS_FILE` env override) — {id 'u_<8hex>', email (unique lowercase),
  scrypt passwordHash + per-user salt, role owner|operator|member,
  display_name, created_at, disabled}; first registered user = owner (env
  `TG_FIRST_USER_ROLE` overrides), later signups = member. `data/sessions.json`
  (atomic 0600, fail-closed; `TG_SESSIONS_FILE` env override) — keyed by
  sha256(token); the plaintext token is NEVER stored, it rides an httpOnly
  SameSite=Lax cookie `tg_session` (Secure behind https). TTL 7d sliding,
  max 200 sessions/user.
- **Inspect:** `GET /v2/auth/me` with the browser cookie; user file via jq
  (passwordHash/salt visible — never a plaintext password); sessions file
  contains hashes only.

### `harness2.js` + mount `106-harness2.js` — project build/run loop (FS-C2)
- **Endpoints:** POST `/v2/harness2/projects` {name, files:{relPath:content}}
  (256 KB total cap, traversal rejected, id = slug of name); GET
  `/v2/harness2/projects` + `/:id`; POST `/:id/build` (files/ → jail/ copy);
  POST `/:id/run` (node entry in jail). RBAC on create/build/run: operator
  role, cap `harness.run`, or `*`.
- **Approval gate:** manifest `requiresApproval=true` → run requests park in
  the approvals store (202 `needs_approval`); execution happens only after
  operator approval via the `harness2.run:<id>` executor.
- **Honest limitation:** the jail is a same-user directory — process
  discipline (no shell, env scrubbed to PATH/HOME/NODE_ENV, 10 s SIGKILL,
  8 KB output tails), NOT an OS sandbox.
- **Audit events:** `harness2_project_created` {id, fileCount};
  `harness2_run` {id, ok, exitCode, durationMs}. Never file contents,
  never stdout/stderr.
- **Storage:** `data/harness2/<id>/{manifest.json, files/, jail/}`.
- **Inspect:** `GET /v2/harness2/projects/:id`; jail contents on disk.

## Full audit-event table

Event types emitted from `src/gateway/**`. Extraction rule: every string
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
| 54 | `playground_run` | mounts/80-playground.js (wave C) |
| 55 | `worktree_snapshot` | mounts/55-harness.js |
| 56 | `worktree_remove` | mounts/55-harness.js |
| 57 | `web_fetch` | mounts/65-web.js, src/gateway/webtools.js |
| 58 | `voice_stt` | mounts/60-voice.js (wave C) |
| 59 | `voice_tts` | mounts/60-voice.js (wave C) |
| 60 | `adapter_registered` | mounts/70-adapters.js (wave C integration adapters) |
| 61 | `adapter_updated` | mounts/70-adapters.js |
| 62 | `adapter_deleted` | mounts/70-adapters.js |
| 63 | `adapter_tested` | mounts/70-adapters.js (payload: id+kind+result only — no URL, no secret value) |
| 64 | `adapter_secret_set` | mounts/70-adapters.js (payload: id+name+length only — value is NEVER stored or logged) |
| 65 | `deploy_artifact` | mounts/75-deploy.js (wave C: rendered service/launcher downloads) |
| 66 | `openai_request` | mounts/85-openai.js (counts only: model, bot, msgCount, charsIn/Out, streaming — no message content) |
| 67 | `trust_scan` | mounts/91-trust.js (D4: metadata ONLY — chars, hits, rule names; scanned text is NEVER stored or logged) |
| 68 | `provider_live_access_denied` | mounts/92-providers-live.js (D5: worker attempted access to live probe) |
| 69 | `provider_live_probed` | mounts/92-providers-live.js (D5: operator successfully probed providers) |
| 70 | `telegram_notify` | mounts/71-telegram.js (D2: chat_id + chars + outcome only — never text, never token) |
| 71 | `telegram_notify_rejected` | mounts/71-telegram.js (D2: non-operator attempt; reason + bot name only) |
| 72 | `observation_scanned` | llm-loop.js (E3: per loop turn, tool + hits + chars — never the text) |
| 73 | `approval_impact_snapshot` | approvals.js (F2: at creation, {approvalId, risk, confidence} — no args) |
| 74 | `memory_added` | memory.js (F3: per fact, {id, bot, source, pin} — text excluded by design — user-owned) |
| 75 | `memory_edited` | memory.js (F3: {id, bot, fieldsChanged[]} — text included only on text change, scope stays inside bot) |
| 76 | `memory_removed` | memory.js (F3: {id, bot, sourceChainSeq} — never the text) |
| 77 | `run_started` | src/gateway/runs.js (wave F F1: a governed Run opened — engine, bot, session, goalId; no args/results, ids only) |
| 78 | `run_completed` | src/gateway/runs.js (wave F F1: run closed — state + exitCode; per-step detail stays in the existing chat_action/approval entries) |
| 79 | `run_paused` | src/gateway/runs.js (wave F F1: cancellable-state transition — parked approval or operator/owner cancel; emitted by store.cancel() via POST /v2/runs/:id/cancel) |
| 80 | `adapter_kind_register` | mounts/99-adapter-kinds.js (G9: {kind, fields count} — field names only, never values) |
| 81 | `adapter_kind_rejected` | mounts/99-adapter-kinds.js (G9: {bot, kind?, errors[]} — validation failures) |
| 82 | `palette_open` | telemetry.js (G12 §20.4 — telemetry ring buffer, not audit chain) |
| 83 | `palette_command` | telemetry.js (G12 §20.4 — telemetry ring buffer, not audit chain) |
| 84 | `palette_search` | telemetry.js (G12 §20.4 — telemetry ring buffer, not audit chain) |
| 85 | `palette_object_resolve` | telemetry.js (G12 §20.4 — telemetry ring buffer, not audit chain) |
| 86 | `palette_nl_intent` | telemetry.js (G12 §20.4 — telemetry ring buffer, not audit chain) |
| 87 | `panel_manifest_validate` | telemetry.js (G12 §20.4 — telemetry ring buffer, not audit chain) |
| 88 | `capability_filter_hit` | telemetry.js (G12 §20.4 — telemetry ring buffer, not audit chain) |
| 89 | `compose_engine_render` | telemetry.js (G12 §20.4 — telemetry ring buffer, not audit chain) |
| 90 | `migration_phase` | telemetry.js (G12 §20.4 — telemetry ring buffer, not audit chain) |
| 91 | `four_oh2_handled` | telemetry.js (G12 §20.4, renamed from `402_429_handled` — extractor-hostile — telemetry ring buffer, not audit chain) |
| 92 | `tg_api_raw_fetch_blocked` | telemetry.js (G12 §20.4 — telemetry ring buffer, not audit chain) |
| 93 | `tg_session_unavailable` | telemetry.js (G12 §20.4 — telemetry ring buffer, not audit chain) |
| 94 | `search_backend_fts5_swap` | telemetry.js (G12 §20.4 — telemetry ring buffer, not audit chain) |
| 95 | `user_registered` | mounts/101-auth.js (FS-A1: {userId, role} — never the password, never the hash) |
| 96 | `user_login_ok` | mounts/101-auth.js (FS-A1: {userId} — humans only; bots stay bearer tokens) |
| 97 | `user_login_failed` | mounts/101-auth.js (FS-A1: {reason} — 'invalid_credentials' or 'account_disabled'; response is always the same generic error, no enumeration) |
| 98 | `user_logout` | mounts/101-auth.js (FS-A1: {userId}) |
| 99 | `identity_me` | mounts/102-identity.js (FS-A2: {userId} only — never email, name or token material) |
| 100 | `chat_user_denied` | mounts/103-chat-user.js (FS-A2: {userId, bot} — grant enforcement; never message text) |
| 101 | `chat_user_ok` | mounts/103-chat-user.js (FS-A2: {userId, session} — namespaced session name only; never message text) |
| 102 | `skill_created` | mounts/105-skills.js (FS-C1: {skillId, name, version, createdBy, owner (FS-F1)} — steps/tool detail not in the event) |
| 103 | `skill_run_started` | mounts/105-skills.js (FS-C1: {skillId, name, bot, steps count, dry, runId} — per-step decisions ride the existing chat_action rows with kind 'skill_step'; FS-G1: a cross-tenant DRY run of a federated skill adds BOTH tags to this SAME row — `tenant: <running-tenant-id>` via tenantAuditTag AND `federatedFrom: <owner-tenant-id>`; non-federated runs keep the exact FS-C1 payload) |
| 104 | `harness2_project_created` | mounts/106-harness2.js (FS-C2: {id, fileCount} — file names/contents stay on disk, never in the chain) |
| 105 | `harness2_run` | mounts/106-harness2.js (FS-C2: {id, ok, exitCode, durationMs} — never stdout/stderr) |
| 106 | `backup_created` | mounts/110-backup.js (FS-B1: {files, chainHead} — file counts + chain head only, never contents/paths) |
| 107 | `backup_restored` | mounts/110-backup.js (FS-B1: {name, files, chainHead} — restore success, counts only) |
| 108 | `backup_restore_refused` | mounts/110-backup.js (FS-B1: {name, reason} — fail-closed on sha256 mismatch/missing file; live data untouched) |
| 109 | `backup_denied` | mounts/110-backup.js (FS-B1: {bot} — non-operator touched a backup route; RBAC refusal audited) |
| 110 | `apikey_created` | mounts/112-apikeys.js (FS-E3: {id, name, scopes} — NEVER the plaintext, never the hash) |
| 110 | `apikey_revoked` | mounts/112-apikeys.js (FS-E3: {id, by} — key id and operator name only) |
| 110 | `apikey_denied` | mounts/112-apikeys.js (FS-E3: {bot} — non-operator touched a key route; RBAC refusal audited) |
| 111 | `tenant_created` | mounts/113-tenants.js (FS-E1: {id, name} — slug id + display name only) |
| 111 | `tenant_disabled` | mounts/113-tenants.js (FS-E1: {id} — tenant id only) |
| 111 | `tenant_enabled` | mounts/113-tenants.js (FS-E1: {id} — tenant id only) |
| 111 | `tenant_denied` | mounts/113-tenants.js (FS-E1: {bot} — non-operator touched a tenant route; RBAC refusal audited) |
| 112 | `skill_denied` | mounts/105-skills.js (FS-F1: {bot, skillId?, action} — non-self-service bot touched the skills surface, or a self-service bot attempted a non-dry run; RBAC refusal audited, never args/steps) |
| 113 | `sandbox_used` | sandbox.js via mounts/106-harness2.js (FS-F3: {id, method: bwrap\|unshare\|none} — optional OS-level wrap, TG_SANDBOX=1 only; method and project id only, never argv/paths) |
| 113 | `sandbox_fallback` | sandbox.js via mounts/106-harness2.js (FS-F3: {id, method, reason≤60 chars} — wrapped child failed at runtime, run retried unwrapped per the documented same-user discipline) |
| 114 | `skill_published` | mounts/105-skills.js (FS-F4: {id, by} — operator marked a skill shared; never steps/args) |
| 114 | `skill_unpublished` | mounts/105-skills.js (FS-F4: {id, by} — operator marked a skill private again; never steps/args) |
| 115 | `observability_read` | mounts/114-observability.js (FS-G2: {by} — operator name only; the snapshot body itself carries scalar projections, never raw payloads/token material) |
| 115 | `observability_denied` | mounts/114-observability.js (FS-G2: {bot} — non-operator touched /v2/observability; RBAC refusal audited) |
| 116 | `skill_federated` | mounts/105-skills.js (FS-G1: {id, by, ownerTenant} — OWNING-tenant operator marked a skill federated; TG_SKILLS_FEDERATION=1 only; never steps/args) |
| 116 | `skill_unfederated` | mounts/105-skills.js (FS-G1: {id, by} — owning-tenant operator pulled a skill back to shared; never steps/args) |
| 116 | `skill_federation_denied` | mounts/105-skills.js (FS-G1: {bot, skillId, action} — cross-tenant write attempt on a federated skill (run/patch/federate/unfederate) refused owner-tenant-only, answered 404 anti-enumeration; TG_SKILLS_FEDERATION=1 only; never args/steps) |
| 117 | `skill_fed_limited` | mounts/105-skills.js (FS-H2: {runnerTenant, skillId, cap, window, limitKind} — a cross-tenant DRY run of a federated skill refused 429 fed_rate_limited because the runner tenant hit TG_FED_RUNS_PER_HOUR (default 20) or the skill hit TG_FED_RUNS_PER_SKILL_HOUR (default 50); enforced BEFORE the dry-run executes; TG_SKILLS_FEDERATION=1 only; never args/steps) |
| 118 | `skill_fed_real_requested` | mounts/105-skills.js (FS-I1: {runId, skillId, ownerTenant, runnerTenant, by} — a cross-tenant REAL run was requested; a pending_real_runs row now awaits DUAL approval; TG_SKILLS_FEDERATION=1 only; never args/steps) |
| 118 | `skill_fed_real_approved_owner` | mounts/105-skills.js (FS-I1: {runId, skillId, by, ownerTenant, runnerTenant} — the OWNING tenant's operator stamped their half of the dual approval; TG_SKILLS_FEDERATION=1 only) |
| 118 | `skill_fed_real_approved_runner` | mounts/105-skills.js (FS-I1: {runId, skillId, by, ownerTenant, runnerTenant} — the RUNNING tenant's operator stamped their half of the dual approval; TG_SKILLS_FEDERATION=1 only) |
| 118 | `skill_fed_real_executed` | mounts/105-skills.js (FS-I1: {runId, skillId, ownerTenant, runnerTenant, bot, runChainSeq, status, completed, resultHash} — the dual-approved cross-tenant REAL run executed; resultHash is a sha256 over the bounded step results, never raw payloads; TG_SKILLS_FEDERATION=1 only) |
| 118 | `skill_fed_real_denied` | mounts/105-skills.js (FS-I1: {bot, runId?, skillId?, reason} — a REAL-run route refused: premature execute without dual approval, wrong tenant side, non-federated skill, or re-execute; nothing executed; TG_SKILLS_FEDERATION=1 only) |
| 119 | `obsv_alert_ratelimit_spike` | obsv-alerts.js via obsv.js snapshot (FS-I2: {count, threshold} — apikeys.rateLimitedLast1h exceeded TG_ALERT_RATELIMIT_THRESHOLD (default 10); delivered out-of-band through the FS-G3 AlertSink with its 60s per-type rate limit + hourly suppression; counts only, never key material; inert when TG_ALERT_URLS is unset) |
| 120 | `obsv_alert_chain_stall` | obsv-alerts.js via obsv.js snapshot (FS-I2: {head, stalledSince} — chain.length unchanged since the last snapshot while uptimeSec exceeded TG_ALERT_CHAIN_STALL_SEC (default 300); last-seen length persisted in kv_store 'obsv:lastChainLen'; head hash + ISO timestamp only, never chain contents; AlertSink rate-limited/suppressed like every type; inert when TG_ALERT_URLS is unset) |
| 121 | `tenant_quota_exceeded` | tenant-scope.js middleware via mounts/* (FS-I3: {tenant, kind: disk\|api, used, limit} — a tenant-resolved request refused 429 quota_exceeded because its scoped data exceeded max_disk_mb or its hourly API count exceeded max_api_per_hour; checked AFTER tenant resolution, BEFORE handler dispatch; checker errors deny too (fail closed); never token material) |
| 122 | `tenant_quota_set` | mounts/115-tenant-quotas.js (FS-I3: {id, by} — operator PUT /v2/tenants/:id/quota; caps only, never token material) |
| 123 | `tenant_quota_read` | mounts/115-tenant-quotas.js (FS-I3: {id, by} — operator GET /v2/tenants/:id/quota usage view) |
| 124 | `tenant_quota_denied` | mounts/115-tenant-quotas.js (FS-I3: {bot} — non-operator touched a quota route; RBAC refusal audited) |
| 125 | `audit_export_webhook` | audit-export.js (FS-I4: {ok, error≤120 chars} — per failed webhook delivery attempt; ok:true attempts are silent, sink metadata only, never entry contents) |
| 126 | `audit_export_backoff` | audit-export.js (FS-I4: {sink:'webhook', reason:'3_failures_in_60s', suppressUntil} — webhook suppressed 5 min after 3 failures in 60 s; storm = DoS vector on the receiver) |
| 127 | `audit_export_s3_stub` | audit-export.js (FS-I4: one-time {bucket, region} — S3 STUB mode announced; no AWS SDK, local JSONL fallback under data/audit-export/<tenant>/<date>.jsonl) |
| 128 | `s3_upload_pending` | audit-export.js (FS-I4: {bucket, key} — the would-be S3 object key `<tenant>/<date>.jsonl` per stub append; drain the fallback deliberately) |
| 129 | `audit_export_test` | mounts/117-audit-export.js (FS-I4: {by, webhookOk, s3StubOk} — operator-triggered POST /v2/audit/export/test self-test; never token material) |
| 130 | `audit_export_denied` | mounts/117-audit-export.js (FS-I4: {bot} — non-operator touched the export-test route; RBAC refusal audited) |
| 131 | `secret_set` | mounts/115-secrets.js (FS-I5: {tenant, key} — secret key NAME and tenant only; the value itself is encrypted at rest (AES-256-GCM, per-tenant key from TG_SECRETS_MASTER_KEY via scrypt) and NEVER logged, audited, or API-readable; TG_SECRETS_VAULT=1 only) |
| 132 | `secret_deleted` | mounts/115-secrets.js (FS-I5: {tenant, key} — key name and tenant only; delete of a missing key is a uniform 404; TG_SECRETS_VAULT=1 only) |
| 133 | `secret_listed` | mounts/115-secrets.js (FS-I5: {tenant} — the listing route returns KEY NAMES only, never values; there is no API route that reads a secret value back, values are consumed by internal code paths only; TG_SECRETS_VAULT=1 only) |
| 134 | `secret_denied` | mounts/115-secrets.js (FS-I5: {bot} — non-operator touched a secrets route; RBAC refusal audited, key names and values never in the payload) |
| 135 | `config_reloaded` | mounts/118-config-reload.js, bin/gateway.js SIGHUP (FS-I6: {changed:[key names], errorCount} — config hot-reload accepted; key NAMES only, never values; source data/gateway.env or env) |
| 136 | `config_reload_failed` | mounts/118-config-reload.js, bin/gateway.js SIGHUP (FS-I6: {changed?, errorCount, error?, bot?, by?} — invalid env value kept the previous value / non-operator touched POST /v2/config/reload / non-reloadable key present in gateway.env; failed keys never take effect) |
| 137 | `chain_archived` | chain-archive.js via mounts/111-chain-archive.js (FS-I7: {bot, archivedCount, manifestKey, headBefore, headAfter} — counts + hashes only; archived entries never re-enter the chain; TG_CHAIN_ARCHIVE=1 only) |
| 138 | `chain_archive_listed` | mounts/111-chain-archive.js (FS-I7: {bot, count} — operator listed archive manifests; keys + counts only) |
| 139 | `chain_archive_refused` | mounts/111-chain-archive.js (FS-I7: {bot, reason, length?} — non-operator touched /v2/chain/archive (RBAC refusal), or archival refused chain_too_short under the <100-entry safety gate; nothing deleted, nothing written) |
| 140 | `secret_master_rotated` | mounts/119-secrets-rotate.js via secrets-vault.js rotateMasterKey (FS-J2: {rotatedCount} — count only; the new master key itself is NEVER logged, audited, or echoed; every tenant_secrets row was re-encrypted under the new master in a single all-or-nothing tx; TG_SECRETS_VAULT=1 only) |
| 141 | `secret_master_rotate_failed` | mounts/119-secrets-rotate.js (FS-J2: {failedCount, errors:[{tenant, key, error}]} on an aborted rotation — any row that failed to decrypt under the current master aborted the WHOLE rotation (tx rollback, zero rows written; the listed rows keep their old ciphertext), or {bot} on a non-operator touching POST /v2/secrets/rotate-master; key NAMES only, no values, no master key material) |
| 142 | `chain_restored` | chain-archive.js via mounts/111-chain-archive.js (FS-J3: {bot, manifestKey, restoredCount, skippedDuplicates, newHead} — operator POST /v2/chain/archive/:date/restore succeeded; counts + hashes only, archived payloads are re-verified (sha256 + re-hash) BEFORE insertion and never logged; TG_CHAIN_ARCHIVE=1 only) |
| 143 | `chain_restore_refused` | mounts/111-chain-archive.js (FS-J3: {bot, manifestKey, reason, length?, archiveEntries?} — restore refused: non-operator (RBAC), manifest missing/corrupt, checksum_mismatch, or bloat_guard (live >1000 AND would exceed 10000); the live DB is untouched on every refusal path) |
| 143 | `chain_restore_refused` | mounts/111-chain-archive.js (FS-J3: {bot, manifestKey, reason, length?, archiveEntries?} — restore refused: non-operator (RBAC), manifest missing/corrupt, checksum_mismatch, or bloat_guard (live >1000 AND would exceed 10000); the live DB is untouched on every refusal path) |
| 144 | `federation_audit_read` | mounts/120-fed-audit.js (FS-K1: {by, filters} — operator queried /v2/federation/audit; filter keys only, never row payloads; TG_SKILLS_FEDERATION=1 only) |
| 145 | `federation_audit_denied` | mounts/120-fed-audit.js (FS-K1: {bot} — non-operator touched /v2/federation/audit; RBAC refusal audited; TG_SKILLS_FEDERATION=1 only) |
| 146 | `telemetry_tenant_read` | mounts/123-telemetry-tenant.js (FS-K2: {by, tenant, count} — operator queried /v2/tenants/:id/telemetry; payloadSummary only, never raw args/steps/text; TG_TELEMETRY_TENANT_SCOPED=1 only) |
| 147 | `telemetry_tenant_denied` | mounts/123-telemetry-tenant.js (FS-K2: {bot, tenant, reason} — non-operator touched a tenant telemetry route, or cross-tenant query refused 404 anti-enumeration; tenant id + reason only) |

### `secrets-vault.js` + mounts `115-secrets.js` / `119-secrets-rotate.js` — tenant secrets vault + master-key rotation (FS-I5, FS-J2)
- **Endpoints:** `PUT/GET/DELETE /v2/tenants/:id/secrets[/:key]` (operator;
  FS-I5), `POST /v2/secrets/rotate-master` {newMasterKey} (operator; FS-J2).
  Worker access → 403 + refusal audited.
- **Rotation semantics (FS-J2):** reads EVERY tenant_secrets row, decrypts
  under the current TG_SECRETS_MASTER_KEY, re-encrypts under the new master,
  writes back in a single transaction. ALL-OR-NOTHING: any row that fails to
  decrypt (corrupt / stale master) aborts the whole rotation — tx rollback,
  ZERO rows written, `409 rotate_failed` with the failing (tenant, key,
  error) list so the operator can heal and retry. Never partial: a
  half-rotated vault would silently lock the old master out of some rows.
  On success process.env.TG_SECRETS_MASTER_KEY is updated in-process, so
  subsequent ops use the new key without a restart. Guards: vault off →
  404 vault_disabled; newMasterKey === current → 400 same_key;
  newMasterKey < 16 chars → 400 weak_key.
- **Audit events:** `secret_master_rotated` {rotatedCount};
  `secret_master_rotate_failed` {failedCount, errors[]} (names only) or
  {bot} on RBAC refusal. The master key material itself is NEVER logged,
  audited, or echoed in any response.

### `hot-reload.js` + mount `118-config-reload.js` — config hot-reload (FS-I6)
- **Endpoints:** `POST /v2/config/reload` (operator-only — same isOperator
  gate as 110-backup/112-apikeys/113-tenants; workers get 403 +
  `config_reload_failed` {bot, error:'operator_required'}). `kill -HUP` on
  bin/gateway.js runs the exact same reload.
- **Reloadable keys** (thresholds + routing only): `TG_ALERT_URLS`,
  `TG_ALERT_RATELIMIT_THRESHOLD`, `TG_ALERT_CHAIN_STALL_SEC`,
  `TG_TENANT_DEFAULT_DISK_MB`, `TG_TENANT_DEFAULT_API_PER_HOUR`,
  `TG_FED_RUNS_PER_HOUR`, `TG_FED_RUNS_PER_SKILL_HOUR`.
- **NOT reloadable (restart required, by design):** `BOT_TOKENS`
  (credentials are read once at boot — a reload must never swap identities)
  and `PORT` (the socket is bound at boot). Present in `gateway.env` →
  refused with error `not_reloadable`, old value kept.
- **Source:** `data/gateway.env` (`$TG_DATA_DIR` respected; KEY=VALUE
  lines, `#` comments, optional quotes) when present — file entries
  override `process.env`, keys absent from the file fall back to
  `process.env`; no file → `process.env` only.
- **Semantics:** `changed` lists only keys whose effective value actually
  differs (unchanged keys are never listed); an invalid value (non-integer
  / <= 0) is an `errors` entry (`invalid_value`) and the PREVIOUS value
  stays in effect — fail-safe, never fail-open. On change both
  `gw.config[key]` and `process.env[key]` are updated so live consumers
  (`skills-federation.capFromEnv`, the AlertSink) pick the value up on
  their next read. `reload()` NEVER throws — the gateway cannot crash on a
  bad reload.
- **Audit hygiene:** audit rows carry changed key NAMES and an error COUNT
  only — never secret values (the only raw value ever recorded is an
  invalid numeric literal, truncated to 60 chars).
- **Inspect:** `GET /v1/audit?q=config_reloaded` (chain rows), or read
  `data/gateway.env` directly.

### `sandbox.js` — optional OS sandbox layer for the harness2 jail (FS-F3)
- **What it is:** a spike, additive and default-OFF. The jail's real
  guarantee remains the same-user process discipline documented under
  `harness2.js`. With `TG_SANDBOX=1`, harness2 runs are additionally wrapped
  via bwrap (full layer: private /tmp tmpfs, jail + node binary + minimum
  lib dirs read-only, network removed unless opted in) or — weaker, honestly
  documented — unshare user+mount+net+pid namespaces with a mapped non-root
  uid.
- **Honest detection:** `detectSandboxSupport()` probes the real host
  (`which bwrap`, `unshare --user --map-root-user true`, `which systemd-run`)
  with 5 s timeouts and returns booleans + probe error strings. No
  assumptions; systemd-run is detected but not used for wrapping yet.
- **Graceful degradation:** no primitives (or a runtime wrap failure) → the
  run executes unwrapped, byte-identical to the pre-FS-F3 path, with a
  `sandbox_fallback` row explaining why. Unwrapped = current discipline,
  documented here and in sandbox.js/harness2.js headers.
- **Audit events:** `sandbox_used` {id, method}; `sandbox_fallback`
  {id, method, reason}. Never argv, never paths, never output.

### `backup.js` + mount `110-backup.js` — verified backup/restore (FS-B1)
- **Endpoints:** `GET /v2/backup` (list, operator), `POST /v2/backup`
  (create, operator), `POST /v2/backup/restore` {name} (operator).
- **Manifest:** {files:[{name,size,sha256}], chainHead, chainId, createdAt}
  — every file sha256-verified BEFORE restore replaces anything; restore
  fails closed on any mismatch/missing/corrupt manifest.
- **Honest limitation:** backups are byte copies (no consistent-snapshot
  window across multiple files); the SQLite db is copied with the same
  window risk as JSON — documented in backup.js header. Restore integrity
  is still exact: what was backed up is what comes back.
- **Storage:** `data/backups/backup-<ISO>/` (atomic dir rename, FIFO last
  10).

### `chain-archive.js` + mount `111-chain-archive.js` — chain compaction / archival (FS-I7)
- **Endpoints:** `POST /v2/chain/archive` {beforeIso?} (operator; triggers
  archival), `GET /v2/chain/archive` (operator; lists archive manifests),
  `GET /v2/chain/archive/:date` (operator; manifest details BEFORE a
  restore — FS-J3), `POST /v2/chain/archive/:date/restore` (operator;
  checksummed re-import — FS-J3).
  All audited; worker access → 403 + `chain_archive_refused` or
  `chain_restore_refused`.
- **Gating:** `TG_CHAIN_ARCHIVE=1` enables archival — unset means fully
  INERT (POST answers 501 `archive_disabled`; the module never reads,
  writes or deletes anything). `TG_CHAIN_ARCHIVE_DAYS` sets the age
  threshold (default 90).
- **Behavior:** entries older than the cutoff move to
  `data/archive/chain-<date>.jsonl` (append-only; per-run sha256 recorded
  in the manifest), are deleted from `chain_entries` (genesis seq 0 is
  never deletable), and the survivors are RE-BASED (seq 1..N,
  prevHash-linked, hashes recomputed) so `verify()` stays green.
- **Honest head change:** compaction changes the chain head by design.
  The kv_store manifest `archive:chain:<date>` records {file, count,
  headBefore, headAfter, archivedAt, sha256} — headBefore is reproducible
  by replaying the archived file (every line carries its ORIGINAL
  seq/hashes and re-verifies). The gap is documented, not hidden (same
  contract as backup/restore, docs/RUNBOOK.md mode 4).
- **Safety:** archival REFUSES (`chain_archive_refused`, HTTP 409) while
  the live chain has fewer than 100 entries — compaction can never wipe a
  young chain. Re-archiving an already-archived period is an audited
  no-op (archivedCount 0, no manifest, no file append). Restore (FS-J3)
  re-verifies the archive sha256 + per-entry re-hash BEFORE touching the
  live DB and refuses (`chain_restore_refused`, HTTP 409, module THROWs)
  on manifest missing/corrupt, file missing, or checksum mismatch; a
  bloat guard refuses when the live chain is >1000 entries and the
  restore would push it past 10000. Restore is idempotent: duplicates
  are skipped by content identity (ts+payload), so a re-run is a clean
  no-op. Restored entries are re-appended at the CURRENT head with
  recomputed seq/hashes — the chain verifies GREEN and never
  time-travels.
- **Audit events:** `chain_archived`, `chain_archive_listed`,
  `chain_archive_refused`, `chain_restored`, `chain_restore_refused` —
  counts, keys and hashes only; entry payloads never logged and file
  contents never logged.

### `telemetry.js` + `mounts/100-telemetry.js` — post-launch telemetry (G12, §20.4)
- **Endpoints:** `POST /v2/telemetry` {event, fields?} (bearer; server-side
  allow-list, unknown event → 400); `GET /v2/telemetry?event=&since=`
  (operator-only).
- **Audit events:** rows 82–94 above are TELEMETRY events, deliberately NOT
  sealed into the hash chain — observability ≠ governance. `gw.telemetry.record()`
  never calls `_audit`, so `GET /v1/audit/verify` length is unaffected by
  telemetry traffic.
- **Storage:** `data/telemetry.json` — bounded ring buffer (max 2000, FIFO),
  atomic tmp+rename, mode 0600; survives restart. Per-type rate limit 250 ms
  (silent drop); fields projected to scalars only.
- **Inspect:** `GET /v2/telemetry` (operator bearer) or read
  `data/telemetry.json` directly (one JSON object with an `events` array).

### `obsv.js` + mount `114-observability.js` — operator observability snapshot (FS-G2)
- **Endpoints:** `GET /v2/observability` (bearer; operator-only, same
  isOperator gate as 110-backup/112-apikeys/113-tenants). Workers get
  403 + `observability_denied`.
- **Audit events:** `observability_read` {by} (operator name only),
  `observability_denied` {bot}.
- **What it returns:** ONE scalar object — chain {ok, length, head},
  telemetry {total, byType top-5 counts, lastAt}, approvals
  {pendingCount}, apikeys {active, rateLimitedLast1h}, tenants {count,
  disabled}, uptimeSec, generatedAt. No caching (computed per call); no
  raw telemetry payloads, no tenant rows, no token material — scalar
  projections only.
- **Honest limitation:** `rateLimitedLast1h` counts keys whose recorded
  `rate_hits` window (within the last hour) reached their configured
  max — blocked attempts are not persisted by `apikeys.verify()`, so it
  is a best-effort signal, not an exact block log.
- **Storage:** none (pure projection of live state; read-only SQL over
  the shared gateway.db connection).
- **Inspect:** `GET /v2/observability` with an operator bearer; the
  console System panel renders the same scalars as a 'System health'
  row (hidden for non-operators).

### `audit-export.js` + mount `117-audit-export.js` — audit-log export (FS-I4)
- **Endpoints:** `POST /v2/audit/export/test` (bearer; operator-only —
  workers get 403 + `audit_export_denied`). Sends a synthetic, clearly
  labeled probe entry to each configured sink and returns
  `{webhookOk, s3StubOk, lastError}`; the probe is NOT sealed into the chain.
- **Sinks (both inert when their env is unset — env-off is byte-identical
  legacy):** webhook `TG_AUDIT_EXPORT_WEBHOOK` (POST JSON, 3 s timeout,
  10 sends/sec, 3 failures in 60 s → suppressed 5 min with
  `audit_export_backoff`); S3 stub `TG_AUDIT_EXPORT_S3_BUCKET`
  (+ `TG_AUDIT_EXPORT_S3_REGION`, default us-east-1) — NO AWS SDK (zero-dep
  rule): entries append to `data/audit-export/<tenant>/<date>.jsonl`
  (`TG_AUDIT_EXPORT_DIR` override) and each append seals
  `s3_upload_pending {bucket, key}` so the fallback can be drained into the
  real bucket deliberately.
- **Wiring:** after every successful chain append, `events.js` taps the
  gateway's 'audit' event and fires `sink.emit(entry)` WITHOUT awaiting —
  a slow/hanging/failing sink never blocks or breaks the audit path. The
  module's own `audit_export_*`/`s3_upload_pending` rows are never
  re-exported (re-entrancy guard). Both sinks inert → no listener at all.
- **Audit events:** `audit_export_webhook` (failed attempts),
  `audit_export_backoff`, `audit_export_s3_stub` (one-time announcement),
  `s3_upload_pending`, plus mount rows `audit_export_test`,
  `audit_export_denied`.
- **Honest limitation:** the S3 sink is a STUB — it writes a local JSONL
  fallback and names the would-be object key; nothing leaves the host until
  an operator (or a future uploader slice) drains it. The webhook sink
  delivers real HTTP but is best-effort: after backoff, entries are NOT
  queued — the chain remains the source of truth, the export is a mirror.
- **Inspect:** `POST /v2/audit/export/test` (operator bearer); fallback
  files under `data/audit-export/`; audit search `q=audit_export`.

Note (FS-C1): per-step skill governance deliberately does NOT add a new
event type — every step emits a standard `chat_action` row tagged
`kind: 'skill_step'` ({skillId, seq, tool, decision}), so skill runs are
auditable with the exact same chain vocabulary as chat proposals.
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