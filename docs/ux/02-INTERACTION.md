# UX SPEC — Dynamic UI, Chat, Agent, Work (§5–§8)

**RESUMÉ:** Denne spec definerer den interaktive overflade (§5 kompositionsmotoren, §6 chat-oplevelsen, §7 agent-oplevelsen, §8 arbejde/mission-oplevelsen) for Trust Gateway. Målet er et operationsunderlag, hvor chat er én af flere indgange, alting er objekter med provenuance, og risikoen er et førsteklasses visuelle aksen. Den danske produktejer forstår konventionen: kort, dokumenteret, testbar.

---

## §5 Dynamic UI Composition — the composition engine as a formal spec

The composition engine is the function that maps **inputs** → **surface stack**. It is NOT a layout library; it is the decision function that decides *which surfaces appear, in what order, for whom, given what*.

### 5.1 Inputs (the composition context vector)

The engine consumes exactly these named inputs — no others:

| Input | Type | Source | MUST rule |
|---|---|---|---|
| `intent` | enum: `explore\|compose\|execute\|approve\|review\|monitor\|admin` | User action / route | MUST be present; unknown intent → fallback surface (Feed) |
| `context` | opaque id + typed tags | Session / workspace | MUST resolve to a stable key; same context ⇒ same composition (§5.4) |
| `work-state` | `idle\|running\|blocked\|awaiting-approval\|error\|done` | Real-time from chain | MUST drive surface ordering (running/blocked rise) |
| `risk` | `read\|write\|destructive\|secret` | Policy classify | MUST override everything (§5.2) |
| `permissions` | Capability grants list | RBAC / `canApprove` | MUST filter surfaces the user cannot act on (dim, never hide) |
| `capabilities` | List of grantable verbs | Agent / human profile | MAY shape available Composer actions |
| `device` | `desktop\|mobile\|terminal` | UA / config | MAY swap surface density; MUST never drop a surface class |
| `attention` | Queue position, urgency score | Attention queue (FIFO by risk) | MUST surface the Queue when non-empty and risk ≥ write |

### 5.2 Scoring / priority rules

The engine produces a **surface stack** (ordered list of Surface references from the kernel vocabulary). Priority is resolved in this exact order:

1. **MUST rules first — risk overrides.** If `risk = destructive`, a `Modal/Drawer` (risk-gated) MUST be inserted at stack position 0 and MUST dim all background surfaces. MUST NOT render destructive actions inline without the gate.
2. **MUST — pending approval pinning.** When `work-state = awaiting-approval`, the `Queue` surface MUST be pinned at stack position 0 (top) for the relevant approver, regardless of intent.
3. **SHOULD — learned preferences MAY.** After MUST rules are satisfied, the engine MAY re-rank remaining surfaces by user preference history (stored per-workspace, opt-in, auditable). MUST NOT use learned prefs to elevate a surface past a MUST gate.
4. **MAY — device density.** MAY collapse `Detail` into `Summary` on `mobile`; MUST keep all surface *classes* represented.

### 5.3 Profile snapshots — five audience segments (concrete example stacks)

Each snapshot is the literal output shape of the composition engine for that segment. All stacks use only kernel Surface vocabulary.

**Segment A — Operator (human, low-risk monitoring, mobile):**
```
[ Feed, Board, Queue(pinned if non-empty), Summary(Detail collapsed), Terminal ]
```
- Intent: `monitor`. Device: `mobile`. Risk gate: read-only view; destructive actions hidden by permission filter.

**Segment B — Approver (human, incoming approvals, desktop):**
```
[ Queue(pinned), EvidencePanel(x2), Detail(action), Modal/Drawer(destructive gate), Action proposal buttons ]
```
- Intent: `approve`. Risk overrides pin Queue. EvidencePanel shows chain trace per decision.

**Segment C — Agent Builder (human, constructing an agent, desktop):**
```
[ Composer, Detail(capability grants), Diff(skills/MCP attach), Test-run panel, Board(agents) ]
```
- Intent: `compose`. Composer produces ActionProposal objects. Test-run panel (§7.5) is SHOULD.

**Segment D — Manager / Team Lead (human, mission oversight, desktop):**
```
[ Goal/Mission Detail, Graph(team), Timeline(loop), Outcome panel(evidence→artifacts), Queue(pinned if blocked) ]
```
- Intent: `review`. Outcome-first framing (§8.4).

**Segment E — External Collaborator / Guest (read-mostly, terminal or mobile):**
```
[ Feed, Summary(Detail), Terminal(readonly) ]
```
- Intent: `explore`. Permissions filter strips all Composer and action surfaces. Read-only; no Modal/Drawer for destructive actions (they cannot appear).

### 5.4 Stability rule — same context ⇒ same composition

**Context switch (formal definition):** a change in any of {`intent`, `context` id, `device`} is a *context switch*. The composition engine MUST produce a deterministic stack for every stable context. Two calls with identical input vectors MUST return identical stacks (bit-for-bit surface ordering).

**Preference drift (formal definition):** a change in `permissions`, `capabilities`, `work-state`, `risk`, or `attention` that the user did not explicitly trigger is *preference drift*. The engine MAY adapt to preference drift (re-rank MAY surfaces) BUT MUST NEVER move a surface that the user has manually pinned, resized, or reordered without an explicit user action (drag, pin, dismiss). Manual layout overrides persist until the user undoes them or the context switch resets them (§5.5).

**Adaptation invariant:** when the engine adapts to a drift, it MAY add/remove MAY surfaces and re-rank non-pinned surfaces, but MUST NOT relocate a pinned or manually-positioned surface. The adaptation MUST be logged as an audit entry (seq, ts, payload = {drift-type, surface-affected, old-position, new-position}).

### 5.5 Escape hatch — manual layout mode

- **MUST:** a `Manual Layout Mode` toggle (per workspace) pins the current surface stack as user-authored. When active, the composition engine MUST NOT re-rank, add, or remove any surface — it renders exactly the user's layout.
- **MUST:** the toggle state is persisted per workspace and visible in the UI (a badge: `🖐 Manual`).
- **SHOULD:** on context switch (§5.4), the engine prompts "Keep manual layout or revert to adaptive?" — default is revert.
- **MAY:** an admin can force manual layout on a workspace for auditing/compliance.

```
┌──────────────────────────────────────────────┐
│  🖐 Manual Layout — Workspace "ops-42"        │
│  [Feed][Board][Queue][Detail]  ← user-pinned  │
│  Engine blocked · revert prompt on switch     │
└──────────────────────────────────────────────┘
```

---

## §6 Chat UX — chat as a composer that creates OBJECTS

Chat is a Composer surface (kernel vocabulary) that produces **objects** — `ActionProposal`, `Artifact`, `Run` — not just bubbles. Every turn is a transaction that may create, modify, or append to ledger objects.

### 6.1 Turn anatomy

A turn is a structured unit, not a free-text bubble. Each turn MUST contain:

| Field | Type | MUST / SHOULD |
|---|---|---|
| `id` | string | MUST — globally unique |
| `role` | `human\|assistant\|system\|tool` | MUST |
| `author` | identity + role | MUST |
| `text` | string | MUST |
| `trustScore` | number 0–100 | MUST — from `src/gateway/trust.js` |
| `untrusted?` | boolean | MUST — derived from trust.js |
| `objects[]` | [ActionProposal, Artifact, Run] | SHOULD — objects the turn produced |
| `governanceTrail[]` | [{action, decision, state, seq}] | MUST — inline audit trail |
| `timestamp` | ISO-8601 | MUST |

### 6.2 Trust badge

Every message bubble MUST display a `trustBadge` derived from `src/gateway/trust.js`:
- Score ≥ 80: green badge (trusted)
- Score 50–79: amber badge (review)
- Score < 50: red badge (untrusted) + MUST show `untrusted?` flag prominently
- `untrusted? = true`: the message MUST be visually flagged; the user MUST be able to see *which* trust.js signal produced the flag
- MUST NOT suppress the badge; it is always visible

### 6.3 Governance trail — inline, per action

Every `<action>` in a turn MUST carry an inline governance trail:

```
┌─ Action: fs.write("/config.json", new) ─────────────┐
│  decision: needs_approval · state: pending           │
│  chain seq: #482 · ts: 2026-09-03T14:22:01Z          │
│  requestedBy: bot:architect · requestedBy role: op  │
│  [▶ Jump to Approval Queue · position #3]            │
└─────────────────────────────────────────────────────┘
```

- MUST: each action shows `decision` (allow|deny|needs_approval) + `state` + chain seq.
- MUST: pending approvals shown as a **first-class inline card** with a jump-to-queue link (not buried in a dropdown).
- MUST: denials show the denier + reason.
- SHOULD: the trail collapses to a one-line summary on hover, expands on click.

### 6.4 Multi-agent rooms

Rooms (kernel: W2 group chat) are multi-agent spaces with human + multiple bots.

- **Who's speaking:** MUST display a speaker badge per message (`human` vs `agent:name`) with the agent's role and a live status dot (idle|thinking|acting|blocked|awaiting-approval|error — see §7.1).
- **Agent-to-agent vs agent-to-human addressing:**
  - MUST distinguish `A2A` (envelope `{from, to:room, kind:'message'|'proposal'|'handoff', body}`) from `A2H` (human-directed).
  - A2A envelopes MUST be visually distinct (e.g., dashed border, `🤝 A2A` tag).
  - A2H messages MUST show the target human's avatar/name.
- **Mute / pin:**
  - MUST: each agent in a room is individually mute-able (silences their messages but keeps them in the chain for audit).
  - MUST: any agent or message thread can be pinned (pinned items float above the feed).
  - Pin/mute state MUST be persisted per-workspace.

### 6.5 Model / provider indicator

- MUST: each assistant message carry a live `modelIndicator` showing the model name + provider + latency.
- MUST: live from `/v2/providers/live` (Provider surface: `{name, surface: llm|voice|telegram|openai-compat, ok, httpStatus?, detail}`).
- SHOULD: show a colored dot (🟢 ok / 🟡 degraded / 🔴 down) based on `httpStatus` / `ok`.
- MUST NOT block the message on provider status; the indicator is informational.

### 6.6 Voice mode (STT/TTS)

- MUST: voice mode is provider-neutral — `stt()` / `tts()` accept a backend name (PLATFORM-ABI: default backend = `null` = echo/no-op JSON; env `TG_TTS_URL` enables a real OpenAI-compatible `/audio/speech` POST).
- MUST: never block a request on missing voice; fallback to text silently.
- **Echo honesty:** MUST display the transcribed text (STT echo) inline before the agent processes it, so the human sees exactly what the model "heard". MUST NOT silently suppress the echo.
- SHOULD: show a waveform/voice activity indicator during recording.
- MUST: voice messages carry the same `trustScore` + `governanceTrail` as text messages.

### 6.7 Edit / regenerate semantics — hash-chained ledger

Regeneration against a hash-chained ledger has precise semantics:

- **Regenerate MUST mean: re-plan only, NEVER re-execute.** When the user clicks "regenerate" on a turn whose actions may already have executed:
  - MUST: show the **executed-action ledger first** — a read-only list of every action that already ran (with chain seq, decision, result), marked `✅ executed`.
  - MUST: then present a **re-plan** of the un-executed portion only.
  - MUST NOT re-run any action whose `auditSeq` is already confirmed on the chain.
  - MUST: the re-plan is a new `ActionProposal` (new seq) that may create new objects; it does not mutate past entries.
- **Edit:** editing a pending (pre-execution) turn creates a new `ActionProposal` that replaces the old one; the old MUST be marked `superseded` on the chain. Editing an executed turn MUST create a *new* turn that references the old as context — never overwrite.

### 6.8 Streaming states incl. mid-stream failure

- MUST: display streaming states: `⏳ planning` → `🔄 executing [tool]` → `✅ done` / `❌ failed`.
- Mid-stream failure: MUST show partial results (everything executed before the failure) + a failure card with error detail + chain seq of the last successful action.
- MUST: the failure is a state of the object (Run or ActionProposal), never a dead-end screen (kernel principle 6).
- SHOULD: offer "retry from failure point" which creates a new ActionProposal resuming after the last executed seq.

### 6.9 Transparency-page link

- MUST: every session displays a persistent link to its `/h/<token>` transparency page (the pages from wave D).
- MUST: the link shows the session's chain verification status (verified / tamper detected).
- MUST: the transparency page link is present in every chat view, not buried in settings.

---

## §7 Agent UX — the agent as a visible worker

An agent is not a black box; it is a **visible worker** with a roster, a live view, and a detail surface.

### 7.1 Roster board — state per agent

The roster board is a `Board` surface (kernel) showing every agent with its current state, mapped to real chain events:

| State | Real chain event mapping |
|---|---|
| `idle` | No current action; last chain entry ≥ N minutes old |
| `thinking` | ActionProposal created, pending decision |
| `acting` | Action executed (auditSeq emitted) |
| `blocked` | `needs_approval` state; awaiting human decision |
| `awaiting-approval` | Synonym for blocked, pinned in Queue |
| `error` | Run exitCode ≠ 0 or uncaught exception on chain |

- MUST: the roster updates live from SSE `audit` events (PLATFORM-ABI: `gw.on('audit', fn)`).
- MUST: color-code states (green=idle, blue=thinking, amber=acting, red=error, gray=blocked).
- SHOULD: show a small run-count and last-failure-time per agent.

### 7.2 Follow-along live view

- MUST: clicking an agent opens a **follow-along view** with generalized `computer` and `artifacts` panels (PLATFORM-ABI: Computer session = `{id, frames[], actions[]}` streamed via SSE type `computer`; follow-along stream endpoint `GET /v2/artifacts/:id/stream`).
- MUST: the view shows the live feed of the agent's actions + artifacts as they are emitted.
- SHOULD: the follow-along view is a `Feed` + `Detail` composition that can be pinned alongside the main work surface.

### 7.3 Agent detail = capability grants + recent decisions + failure history

The `Detail` surface for an agent MUST show:
- **Capability grants:** the list of verbs/scope the agent holds (from `gw.bots[name].capabilities`). Each grant MUST show source + expiry if temporary.
- **Recent decisions:** the last N chain entries where the agent appears (decision: allow|deny|needs_approval + seq + ts).
- **Failure history:** a `Timeline` of run failures (exitCode, error, chain seq, timestamp). MUST include retry count.
- MUST: every item traces to an `AuditEntry` (seq, ts, payload, prevHash); if not in the chain, mark `unverified`.

### 7.4 Builder flows

When a user builds/configures an agent (Agent Builder profile, §5.3 Segment C):

- **Instructions:** a `Composer` surface to author system prompts / agent instructions. MUST produce an `ActionProposal` on submit.
- **Skills / MCP attach:** a `Diff` surface showing before/after when attaching a skill (markdown/procedure doc with frontmatter, kernel) or MCP server. MUST show the capability delta.
- **Memory policy:** MUST display the agent's memory policy (persistence scope, retention, what is stored). MAY allow editing (produces an ActionProposal).
- **Test-run before deploy (MUST):** before deploying a modified agent, a **simulated dry-run** MUST surface:
  - Run the agent's instructions in a sandboxed simulation.
  - Show projected capability usage, risk classification, and any policy conflicts.
  - MUST NOT execute real actions; the dry-run is read-only simulation.
  - MUST display a pass/fail verdict before the deploy button is enabled.

```
┌─ Test-run (dry-run) ──────────────────────────────┐
│  Simulation: 3 steps projected                    │
│  Risk: write (fs.read) — within policy ✓          │
│  Policy conflicts: none                           │
│  Projected artifacts: 1 doc                       │
│  ┌──────────────────────────────────────────┐     │
│  │  [PASS] Dry-run OK — deploy enabled      │     │
│  └──────────────────────────────────────────┘     │
└───────────────────────────────────────────────────┘
```

### 7.5 Takeover / interrupt semantics

When an operator takes over or interrupts a run:

- **Operator pause:** MUST emit a chain event `{type: 'pause', agent, seq}`. The agent's state MUST transition to `blocked`.
- **Operator owns the run:** After pause, the operator's UI MUST show the current `ActionProposal` + all executed actions (ledger) + a Composer to continue, modify, or abort.
- **Hand back:** When the operator resumes (via Composer action), the engine MUST emit a chain event `{type: 'resume', agent, annotatedContext}` where `annotatedContext` is a human-readable summary of what happened during the pause (actions taken, decisions made, failures). The agent's state returns to `thinking` or `acting`.
- **UI states during takeover:**
  - `paused`: all action buttons disabled except "resume", "abort", "annotate".
  - `owned`: operator's Composer is the active surface; agent's live feed is dimmed but visible (so the operator sees what the agent was doing).
  - `handed-back`: operator's Composer resets; agent feed re-activates.
- MUST: interrupt never loses chain continuity — the pause, annotation, and resume are all linked entries.

### 7.6 Multi-agent teams — delegation chains

- MUST: delegation chains are visible as a `Graph` surface showing `Agent A → Agent B → Agent C` with edge labels (handoff reason, risk class).
- MUST: where A2A envelopes are present (§6.4), the envelope is displayed inline in the relevant agent's feed: `🤝 A2A handoff: {from} → {to}, kind: handoff`.
- SHOULD: delegation depth is visually bounded (max 3 hops visible; deeper chains collapse into a `Detail` view).

---

## §8 Work/Mission UX — goals, missions, loops, continuity

### 8.1 Goals / missions as persistent objects with lifecycle states

Goals and Missions (kernel canonical objects) are persistent, not ephemeral. Their lifecycle states:

| State | Meaning | Transition trigger |
|---|---|---|
| `draft` | Created, not yet started | User creates via Composer |
| `active` | Running; loop may be executing | Start via Composer or schedule |
| `paused` | Temporarily halted | Operator pause (§7.5) or watchdog |
| `blocked` | Awaiting approval | `needs_approval` from chain |
| `done` | Completed normally | Loop exitCode = 0, all steps executed |
| `failed` | Terminated with error | Run exitCode ≠ 0 |
| `cancelled` | Human-aborted | Human cancels via Composer |

- MUST: every state transition is an `AuditEntry` on the chain.
- MUST: the lifecycle is visible as a `Timeline` on the Goal/Mission `Detail` surface.

### 8.2 Three views — one data: board vs timeline vs graph

All three views project the same underlying object data; the choice of view is a composition decision (§5).

| View | Surface | Wins when | Device + role tie |
|---|---|---|---|
| **Work board** | `Board` (state-over-time grid) | Overview of many work objects; filtering by state/role | Desktop; Manager/Team Lead, Operator |
| **Timeline** | `Timeline` (time-axis of one object) | Deep dive on a single Goal/Mission/Run | Desktop or mobile; any role |
| **Graph** | `Graph` (relationship view) | Understanding delegation chains, dependencies, team structure | Desktop; Manager, Agent Builder |

- MUST: switching views does NOT change the underlying data — it re-projects.
- MUST: the active view is composable with other surfaces (e.g., Board + Queue pinned).
- SHOULD: on `mobile`, Board and Graph collapse to a `Feed`-first composition; Timeline remains available.

### 8.3 Loops — schedule, watchdog states, silent-approval policy

- **Schedule:** A loop may have a `schedule` (cron-like). MUST display next-run time on the Goal/Mission `Detail`. MUST show schedule as a `Timeline` marker.
- **Watchdog states:** A watchdog monitors a running loop and emits chain events on timeout or anomaly. MUST display watchdog status (active/expired/alerted) inline. MUST: watchdog alert pushes the object into `blocked` and pins it in the `Queue`.
- **Silent-approval policy (MUST):**
  - MUST: silent approval is allowed ONLY for `read`-class actions.
  - MUST NOT auto-approve `write`, `destructive`, or `secret`-class actions — EVER.
  - SHOULD: for `write` actions below a configurable threshold, a "quiet confirm" MAY be shown (non-blocking toast, not a gate).
  - MUST: the silent-approval policy is visible on the `Control` domain surface, editable by Workspace Admin or Security/Governance Admin.

### 8.4 Resume / continue affordances

- **Where did I stop:** MUST provide a "continuity anchor" on every resumed session/work object — a visible marker showing the last executed chain seq, the last object state, and the reason for stopping (human cancel, error, pause, approval needed).
- MUST: resume creates a new `Run` referencing the previous `Run.id` as `parentId` — never overwrites.
- SHOULD: the resume affordance is a button on every `blocked`, `failed`, or `paused` object.
- MUST: resuming an object with pending approvals MUST show the approval status first (Gate before resume).

### 8.5 Outcome-first framing for Managers

For the Manager/Team Lead profile (§5.3 Segment D), the UI MUST frame work in outcome-first terms:

- **Goal → Evidence → Artifacts chain:**
  - The Manager sees the **Goal** (intent/objective).
  - Below it, the **Evidence** (chain entries, decision logs, metric changes) that the goal is being met.
  - Below evidence, the **Artifacts** (produced outputs) with provenance links.
  - MUST NOT show task ticks or step counters as the primary view — those are secondary, behind an expand.
- MUST: the outcome panel is a `Detail` + `EvidencePanel` + `Artifact` composition.
- SHOULD: the Manager can toggle to a `Board` view for portfolio-level status.

---

## Acceptance criteria — 20+ testable statements

The following statements are machine-checkable against the rendered UI or the composition engine's output. Each is phrased as a MUST/SHOULD/MAY assertion with a verification method.

1. **§5.2 T1 (MUST):** Given `risk = destructive`, the composition engine returns a stack whose position 0 is `Modal/Drawer` — verified by composing with risk=destructive and inspecting stack[0].
2. **§5.2 T2 (MUST):** Given `work-state = awaiting-approval`, the `Queue` surface is at stack position 0 for any approver — verified by composing with work-state=awaiting-approval and role=approver.
3. **§5.2 T3 (MUST):** Learned preferences never elevate a surface past a MUST gate — verified by asserting stack positions of MUST-gated surfaces are invariant under preference-weight perturbation.
4. **§5.3 T4 (MUST):** Each of the five profile segments produces a deterministic, non-empty stack using only kernel Surface vocabulary — verified by composing for each segment and asserting vocabulary compliance.
5. **§5.4 T5 (MUST):** Same input vector ⇒ same stack (bit-for-bit) — verified by composing twice with identical vectors and asserting deep equality.
6. **§5.4 T6 (MUST):** A pinned surface is never relocated by preference drift — verified by pinning surface X, applying drift, asserting X.position is unchanged.
7. **§5.5 T7 (MUST):** Manual Layout Mode toggle blocks all engine re-ranking — verified by enabling manual mode, changing intent, asserting stack is identical.
8. **§6.1 T8 (MUST):** Every turn contains `id`, `role`, `author`, `text`, `trustScore`, `untrusted?`, `governanceTrail[]`, `timestamp` — verified by inspecting any rendered turn object.
9. **§6.2 T9 (MUST):** Every assistant message displays a trustBadge whose color maps correctly to trustScore ranges (≥80 green, 50–79 amber, <50 red) — verified by rendering messages with known scores.
10. **§6.3 T10 (MUST):** Every action with `decision = needs_approval` renders a first-class inline approval card with a jump-to-queue link — verified by rendering a turn containing such an action.
11. **§6.4 T11 (MUST):** A2A envelopes are visually distinct from A2H messages (e.g., dashed border + `🤝 A2A` tag) — verified by inspecting the rendered DOM/CSS of A2A vs A2H messages.
12. **§6.5 T12 (MUST):** Every assistant message carries a `modelIndicator` populated from `/v2/providers/live` — verified by fetching provider live data and asserting indicator matches.
13. **§6.7 T13 (MUST):** Regenerate on an executed turn shows the executed-action ledger FIRST, then a re-plan — verified by triggering regenerate and asserting ledger renders before the re-plan surface.
14. **§6.7 T14 (MUST):** Regenerate never re-executes an action with a confirmed `auditSeq` — verified by asserting no new chain entry is created for already-executed actions.
15. **§6.8 T15 (MUST):** Mid-stream failure renders partial results + a failure card with chain seq — verified by simulating a mid-stream failure and inspecting rendered output.
16. **§6.9 T16 (MUST):** Every session view contains a `/h/<token>` transparency link — verified by scanning the session DOM for a link matching `/h/`.
17. **§7.1 T17 (MUST):** The roster board renders every agent with a state mapped from real chain events (idle|thinking|acting|blocked|error) — verified by querying the chain and asserting roster state matches.
18. **§7.4 T18 (MUST):** Deploy button is disabled until the dry-run simulation returns PASS — verified by modifying an agent and asserting deploy button.disabled = true before pass, false after pass.
19. **§7.5 T19 (MUST):** Operator pause emits a chain event and transitions agent state to `blocked` — verified by triggering pause and asserting an audit entry with type='pause' exists and state=blocked.
20. **§8.1 T20 (MUST):** Every lifecycle state transition creates an `AuditEntry` — verified by transitioning a Goal through draft→active→done and asserting chain entries exist for each transition.
21. **§8.3 T21 (MUST):** Auto-approval is NEVER granted for `destructive` or `secret` actions — verified by attempting silent-approval on a destructive action and asserting it requires explicit human decision.
22. **§8.4 T22 (MUST):** Resume on a `blocked` object shows approval status before allowing resume — verified by resuming a blocked object and asserting approval state is displayed and resume is gated.
23. **§8.5 T23 (MUST):** The Manager outcome panel shows Goal → Evidence → Artifacts chain, with task ticks behind an expand — verified by rendering the Manager view and asserting the primary content is the outcome chain.
24. **§5.4 T24 (MUST):** Adaptation drift is logged as an audit entry with {drift-type, surface-affected, old-position, new-position} — verified by inducing drift and asserting a log entry exists.

---

## Backend gaps

- **BACKEND GAP: composition engine scoring function** — the formal scoring/priority engine (§5.2) is specified but no backend service implements it yet; the surface stack must be computed client-side or via a new mount endpoint until the engine is built.
- **BACKEND GAP: manual layout mode persistence** — per-workspace manual layout state has no storage path yet; the `data/` JSON file pattern (PLATFORM-ABI) should be used, but the mount and schema are not yet defined.
- **BACKEND GAP: dry-run simulation sandbox** — §7.4 requires a sandboxed dry-run that projects capability usage and risk without executing; no sandbox/executor exists in the current codebase.
- **BACKEND GAP: A2A envelope rendering** — the Room A2A envelope format is defined in PLATFORM-ABI but the console-side rendering surface for distinguishing A2A vs A2H is not yet wired.
- **BACKEND GAP: trust.js score exposure** — `src/gateway/trust.js` produces scores per message, but a live query endpoint for the frontend to fetch per-message trust data is not yet confirmed in the mount surface.

---

*Author: §5–§8 spec agent (wave v2e/ux2). References: `00-KERNEL.md` (binding vocabulary), `PLATFORM-ABI.md` (platform contract). Does NOT edit `README.md` (author 1 owns the index).*
