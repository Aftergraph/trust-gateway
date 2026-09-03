# §1–§4 Foundation — product definition, IA, domain model, surface architecture

> **RESUMÉ:** Dette dokument er den fundamentale specification for Trust Gateway UI/UX. Produktet er et ledelses-konsol-ui for styrede agent-operationer med hash-kædet revisjonslog, policy-gated handling og menneskelig kontrol. Specifikationens sprog er engelsk med dansk resume, som angivet i kernelen.

---

## §1 Product definition

### §1.1 What Trust Gateway IS

Trust Gateway is a **governed agentic operating console**: a single object space where humans and agents co-exist, every action is policy-gated and hash-chained into an audit ledger, and the UI is the human's control surface over that machinery. Chat is one entry point among several — not the product. The console surfaces the *governed loop* (propose → classify → decide → approve/execute → seal) as the primary visual thread. Every stateful decision passes through `gw._audit(payload)` — sealing, persisting, and emitting SSE automatically (PLATFORM-ABI rule 3) — so the UI is never a passive viewer of the chain; it is a participant in it.

**Normative grounding:** 00-KERNEL.md ("the product" + design principles 1–6); PLATFORM-ABI.md rules 1–10 (zero npm deps, mounts-only routes, `gw._audit` sealing, `data/` atomic persistence, XSS policy, `canApprove` RBAC).

### §1.2 What Trust Gateway ISN'T

- **Not a chat app with extras.** Chat (CHAT domain) is one of nine navigation roots; messages are one object type among many.
- **Not a static dashboard.** No card grids, no page-first layouts. Every surface is composed dynamically from {intent, work-state, risk, permissions, capabilities, device, attention} (§4).
- **Not an LLM wrapper.** The Brain (BRAIN domain) is a provider; brain output is *untrusted text* that may only PROPOSE via ChatPlanner — never execute directly (PLATFORM-ABI "Brain" definition).
- **Not a settings panel.** Risk is a first-class visual axis, not a toggle buried in preferences.
- **Not a generic workflow tool.** Every step is gated by `classify()`/`decide()` against the owner bot's capabilities; nothing executes outside that gate.

### §1.3 Five audience segments → product promises

Mined from the kernel's 12-role model (00-KERNEL.md "Role model"); current system knows only worker/operator bot roles, so these are *promise targets*, not shipped features.

| Segment (roles) | Core need | Product promise |
|---|---|---|
| **Operators & Approvers** (Operator, Approver) | Execute + approve under pressure | Instant situational awareness (NOW feed), one-tap approval with full evidence |
| **Builders & Workflow Engineers** (Agent Builder, Workflow Builder, Developer/Platform Admin) | Construct & iterate governed chains | Visual builder with *preview* of policy outcome before any execution |
| **Team & Org Leadership** (Manager/Team Lead, Workspace Admin, Organization Owner) | Delegate with least privilege | Cross-workspace scope switcher; delegation graph visible in Graph surface |
| **Security & Governance** (Security/Governance Admin, Auditor/Reviewer) | Compliance & chain integrity | Immutable audit trail; EvidencePanel for every decision; `chain.verify()` always visible |
| **Members & External Collaborators** (Member, External Collaborator/Guest) | Participate safely | Scoped read + limited propose; guest-safe projections (no secrets, no other-bot jail contents) |

### §1.4 Non-goals (MUST NOT)

1. MUST NOT persist secret values in the audit chain — args/argsSummary scrubbed on resolve, secrets stored as hash+fingerprint only (PLATFORM-ABI rule 5, `approvals.js` + `adapters.js` pattern).
2. MUST NOT render via `innerHTML=` — XSS policy enforced by tests; textContent only (PLATFORM-ABI rule 7).
3. MUST NOT hit real providers in tests; mock with local `http.createServer` stub (PLATFORM-ABI rule 8).
4. MUST NOT edit `src/gateway/server.js` or another agent's mount files.
5. MUST NOT assume the 12 roles are implemented — mapping is a spec task, not a shipped capability.

### §1.5 Success metrics

| Metric | Definition | Target |
|---|---|---|
| **Time-to-trust** | Seconds from session open to first verified object (chain-sealed, `chain.verify() === true`) visible on screen | < 2 s |
| **Approval latency** | P95 wall-clock from `approval_requested` audit event to `approval_resolved` — measured at the Approver's screen render | < 15 s (TTL = 15 min by default) |
| **Interrupt coverage** | % of in-flight runs/sessions where the human can see *what* the agent is doing, *why*, *with what data*, and issue an interrupt (§5 design principle 5) | 100% of active objects |
| **Chain integrity** | `chain.verify()` seal on every render that surfaces chain data | 100% sealed, 0 TAMPERED renders |
| **Provenance coverage** | % of rendered facts that carry a valid `chainSeq` + back-reference to an `AuditEntry` | ≥ 95% (5% tolerated for real-time feeds under SSE) |

The five segments collapse the kernel's 12-role model along two axes — *control intensity* (how much execute/decide authority) and *scope breadth* (individual user vs. org-wide governance). The current system implements only worker/operator bot roles; the promises above are the target surface, not the shipped surface, and each row is an acceptance target for a follow-on wave.

---

## §2 Information architecture

### §2.1 Nine top-level domains (navigation roots)

Canonical from 00-KERNEL.md "Top-level domains"; code anchors from PLATFORM-ABI wave matrix and `server.js` mounts.

| Domain | Object types owned | Entry intents | Cross-domain references |
|---|---|---|---|
| **NOW** | Approval (pending), Run (live), Session (active attention) | "What needs me now?" — attention queue, pending approvals, running work | CHAT→ActionProposal→CONTROL approval queue; WORK→Run→NOW live feed |
| **CHAT** | Session, Message, ActionProposal, Action | "Converse / propose" — deep-chat, transparency pages | CHAT→ActionProposal→CONTROL approval queue; CHAT→Action→OUTPUT artifact |
| **WORK** | Goal, Mission, Run, Step | "Plan & execute" — goals panel, continuity, slash-run | WORK→Run→OUTPUT artifact; WORK→Step→CONTROL approval; WORK→Run→NOW |
| **AGENTS** | Bot (Agent), Role, Team/Room, Capability | "Build & manage workers" — bots, builder, rooms | AGENTS→Bot→CHAT session; ROOM→Room→CONTROL audit |
| **BRAIN** | Provider, Model, Loop | "Configure intelligence" — models, providers, LLM loop | BRAIN→Provider→CONNECT adapter; BRAIN→Loop→WORK goal |
| **OUTPUT** | Artifact, History, Export | "Consume outputs" — artifacts, history, playground | OUTPUT→Artifact→WORK run; OUTPUT→History→CONTROL chain |
| **CONTROL** | Policy, Approval, Trust, AuditEntry, Risk | "Govern & audit" — policy, approvals, trust, chain verify | CONTROL→Approval→CHAT ActionProposal; CONTROL→AuditEntry→all domains |
| **CONNECT** | Adapter, Integration, Webhook, MCP, Plugin | "Wire external systems" — adapters, hub, plugins | CONNECT→Adapter→BRAIN provider; CONNECT→Plugin→AGENTS bot |
| **SYSTEM** | Deploy, Health, Storage, CLI/TUI surface | "Operate the console" — deploy, self-repair, health | SYSTEM→Health→NOW; SYSTEM→Deploy→SYSTEM storage |

### §2.2 Navigation model

**URI scheme (object-centric deep links):**

```
/d/<domain>/o/<type>/<id>
```

Examples:
- `/d/CHAT/o/session/sess_001` — a specific session
- `/d/WORK/o/goal/goal_000001` — a specific goal
- `/d/CONTROL/o/approval/apr_000001` — a specific approval
- `/d/NOW/o/run/run_000042` — a live run in the attention queue
- `/d/CONTROL/o/auditentry/seq_000087` — a specific chain entry

**Rules:**
- Every object has a **stable URI** derived from its canonical id — never a sequential page id.
- Domain is the namespace root; `o` is the object separator; `<type>` is the canonical object name (Session, Message, Goal, Run, Approval, ActionProposal, Action, Artifact, AuditEntry, Agent, Capability, Policy, Adapter, Provider, Surface).
- Type names are plural only where the kernel uses plural (none do — all singular per canonical object table).
- The URI is opaque to display: the rendering surface is determined by `<type>`, not by path suffix. A future `type: run_live` resolves to the Run surface, not a new page.
- Anchors within a deep link use `#<field>` to scroll to a named object field (e.g., `/d/CONTROL/o/action/act_000042#auditSeq`).
- Path segments are case-sensitive and must match the canonical object name exactly; a 404 is returned for unknown `<type>` or `<id>` pairs rather than a redirect.

### §2.3 Back/forward semantics & workspace switcher

**Back/forward:** Navigation is a *graph walk* over object deep links, not a linear page stack. The browser back button returns to the *previous object context* (the deep link the user navigated from); forward returns to the deeper object. History entries are keyed by `(domain, type, id)` tuples, so revisiting the same object re-renders its latest state rather than re-creating it.

**Workspace switcher semantics** (`Identity + Role + Scope`):
- **Identity:** the authenticated bot/human principal (from `gw.bots` or bearer token).
- **Role:** one or more of the 12 roles, *per workspace/scope* — a single identity holds different roles per scope (kernel "Role model").
- **Scope:** a workspace boundary (e.g., `org:acme`, `ws:engineering`); switching scope filters the visible object set by the identity's roles in that scope.
- The switcher MUST display the active `(Identity, Role, Scope)` tuple in the chrome at all times; changing any component re-composes the current surface set (§4).

---

## §3 Core domain model

### §3.1 Complete object table

Canonical objects from 00-KERNEL.md (fields never renamed); fields added by this spec marked `NEW:`.

| Object | Canonical fields | Added by this spec | Kind |
|---|---|---|---|
| Session | id, name, createdAt, participants[], turns[] | state: active|closed|archived; NEW: `lastActivityAt`, `workspace` | CHAT |
| Message | role, author, text, trustScore, untrusted? | NEW: `chainSeq`, `provenance`, `status: delivered|displayed|interrupted` | CHAT |
| ActionProposal | tool, args, origin: human|llm|loop, risk, decision? | NEW: `id (prop_<n>)`, `createdAt`, `class` (read|write|destructive), `evidenceChain[]` | CHAT |
| Action | id, proposal, decision: allow|deny|needs_approval, result?, auditSeq | NEW: `startedAt`, `completedAt`, `interruptedBy?` | CHAT |
| Approval | id, action, requestedBy, resolvedBy?, state: pending|approved|denied|expired | NEW: `requestedAt`, `expiresAt`, `resolvedAt`, `ttlMs`, `argsSummary` | CONTROL |
| Goal / Mission | id, intent, steps, loop?, status | NEW: `owner`, `createdAt`, `updatedAt`, `loopRuns` | WORK |
| Step (goal-owned) | tool, state, attempts, lastDecision | NEW: `approvalId`, `updatedAt`, `decisionReason` | WORK |
| Run | goalId?, engine, startedAt, exitCode?, artifacts[] | NEW: `id (run_<n>)`, `status`, `events[]`, `interruptedBy?`, `workspace` | WORK |
| Artifact | id, kind, origin, jailPath?, publicRef? | NEW: `chainSeq`, `provenance`, `createdAt` | OUTPUT |
| AuditEntry | seq, ts, payload, prevHash | — | CONTROL |
| Agent (Bot) | name, role, capabilities[] | NEW: `status: online|offline`, `workspace` | AGENTS |
| Capability | — | grantable verb/scope (fs.read, approval.decide, *…) | AGENTS |
| Policy | — | classify/decide rules; risk classes read|write|destructive | CONTROL |
| Adapter | id, kind, config, secrets: fingerprint-only | NEW: `enabled: bool`, `createdAt`, `testResult: ok|fail|blocked` | CONNECT |
| Provider | name, surface: llm|voice|telegram|openai-compat, ok, httpStatus?, detail | — | BRAIN |
| Surface | — | {inputs, affordances, riskBehavior, emptyState, errorState, loadingState} | — |

### §3.2 State machines

Each table: states, events, transitions, guard conditions (tied to Capability+Policy), and the audit event emitted.

**Session**

| From | Event | Guard | To | Audit |
|---|---|---|---|---|
| active | `interrupt` | capability `session.interrupt` | active (marked interrupted) | `chat_action` |
| active | `close` | identity = owner or operator | closed | (none defined — NEW) |
| closed | `reopen` | identity = owner | active | (none defined — NEW) |

> **BACKEND GAP:** Session state transitions (close/reopen/interrupt) are not yet materialized in `chat.js`; `ChatPlanner` keeps an open Map with no lifecycle states.

**Goal** (from `continuity.js`; states = `GOAL_STATUSES`: active | paused | done | cleared)

| From | Event | Guard | To | Audit |
|---|---|---|---|---|
| — | `add` | owner required; text ≤ 500 chars; steps ≤ 100 | active | `goal_added` |
| active | `pause` | owner or `canApprove`(bot) | paused | `goal_paused` |
| paused | `resume` | owner or `canApprove`(bot) | active | `goal_resumed` |
| active/paused | `clear` | owner or `canApprove`(bot) | cleared | `goal_cleared` |
| active | `complete` | all steps done | done | `goal_completed` |
| active | `takeStep` → allow | policy `decide` = allow | running → done | `goal_stepped` |
| active | `takeStep` → deny | policy `decide` = deny | denied | `goal_step_denied` |
| active | `takeStep` → needs_approval | policy `decide` = needs_approval | awaiting_approval | `goal_step_awaiting_approval` |
| awaiting_approval | `approval_resolved(approve)` | `canApprove`(bot) | done | `goal_stepped` (decision: approved) |
| awaiting_approval | `approval_resolved(deny)` | `canApprove`(bot) | denied | `goal_step_denied` |
| active | `loop.start` | owner or `canApprove`; status=active | active (loop attached) | `goal_loop_started` |
| active | `loop.stop` | owner or `canApprove` | active | `goal_loop_stopped` |

**Run** (first-class object aspirational; current engine runs loop ticks implicitly)

| From | Event | Guard | To | Audit |
|---|---|---|---|---|
| — | `start` | goal active; engine available | running | (goal_stepped / action_executed) |
| running | `complete` | step done / loop maxRuns | complete | `action_executed` |
| running | `fail` | dispatch throws | failed | `action_executed` (ok: false) |
| running | `interrupt` | human interrupt capability | interrupted | `control_released` / NEW `run_interrupted` |
| running | `deny` | policy deny | denied | `goal_step_denied` |

> **BACKEND GAP:** Run is not yet a first-class stored object in `continuity.js`; runs are implicit in loop ticks. Materializing Run requires new `data/runs.json` + store — same atomic-write pattern as `approvals.js`.

**Step** (goal-owned sub-object; states = `STEP_STATES`: pending | awaiting_approval | running | done | denied)

| From | Event | Guard | To | Audit |
|---|---|---|---|---|
| — | `add` | tool required; tool ≤ 128 chars | pending | `goal_added` (step count) |
| pending | `takeStep` → allow | policy `decide` = allow | running → done | `goal_stepped` |
| pending | `takeStep` → deny | policy `decide` = deny | denied | `goal_step_denied` |
| pending | `takeStep` → needs_approval | policy `decide` = needs_approval | awaiting_approval | `goal_step_awaiting_approval` |
| pending | `dispatch fail` | executor throws | pending (retry) | `goal_stepped` (ok: false) |
| awaiting_approval | `approval_resolved(approve)` | `canApprove`(bot) | done | `goal_stepped` (decision: approved) |
| awaiting_approval | `approval_resolved(deny)` | `canApprove`(bot) | denied | `goal_step_denied` |
| running | `interrupt` | human interrupt capability | denied (terminal) | `control_released` / NEW `step_interrupted` |
| done/denied | — | terminal — no further transitions | (unchanged) | — |

> **BACKEND GAP:** `step_interrupted` audit type does not yet exist; Step is materialized only implicitly inside `continuity.goals[].steps[]` — no standalone step URI yet.

**Approval** (from `approvals.js`; states = pending | approved | denied | expired)

| From | Event | Guard | To | Audit |
|---|---|---|---|---|
| — | `request` | bot + tool + args | pending | `approval_requested` |
| pending | `resolve(approve)` | `canApprove`(bot); not expired | approved | `approval_resolved` |
| pending | `resolve(deny)` | `canApprove`(bot); not expired | denied | `approval_resolved` |
| pending | `expire` | now > expiresAt | expired | (sweep sets state; no new type) |
| pending | `resolve` on non-pending | — | error `already_<status>` | `approval_forbidden` |
| approve (resolved) | `execute` | `canApprove` + dispatcher | — | `action_executed_after_approval` |

**ActionProposal** (kernel canonical + spec states)

| From | Event | Guard | To | Audit |
|---|---|---|---|---|
| — | `propose` | human/llm/loop origin; tool classified | proposed | `chat_action` / `action_decision` |
| proposed | `classify` | `classify(tool)` returns risk class | proposed (annotated) | — |
| proposed | `decide` → allow | `decide()` = allow | allow → execute | `action_decision`, `action_executed` |
| proposed | `decide` → needs_approval | `decide()` = needs_approval | needs_approval → Approval | `action_decision`, `approval_requested` |
| proposed | `decide` → deny | `decide()` = deny | denied | `action_decision` |
| needs_approval | `approved` | `approval_resolved(approve)` | approved → execute | `approval_resolved`, `action_executed_after_approval` |
| needs_approval | `denied` | `approval_resolved(deny)` | denied | `approval_resolved` |
| allow | `interrupt` | human interrupt | interrupted | `control_released` / NEW `action_interrupted` |

> **BACKEND GAP:** `action_interrupted` audit type does not yet exist; `control_released`/`control_taken` types are present in the vocabulary but the interrupt wiring (§5 principle 5) is not implemented in `server.js`.

**Adapter** (from `adapters.js`/`adapters-singleton.js`)

| From | Event | Guard | To | Audit |
|---|---|---|---|---|
| — | `register` | kind + name + config validated; id `adp_<n>` | active (enabled: true) | `adapter_registered` |
| active | `test` | probe succeeds | active (testResult: ok) | `adapter_tested` |
| active | `test` | probe fails | active (testResult: fail) | `adapter_tested` |
| active | `secret.set` | named secret | active (secret configured) | `adapter_secret_set` |
| active | `update` | patch validated | active | `adapter_updated` |
| active | `disable` | patch `enabled: false` | disabled | `adapter_updated` |
| disabled | `enable` | patch `enabled: true` | active | `adapter_updated` |
| any | `delete` | — | deleted (terminal) | `adapter_deleted` |

### §3.3 Relationships graph (ASCII)

```
Session ──produces──▶ Message ──contains──▶ ActionProposal ──decides──▶ Action
   │                                           │                          │
   │                                     needs_approval              executes
   │                                           ▼                          ▼
   │                                   Approval ◄──requested──┐    ▼
   │                                           │               │  Artifact
   │                                           │               │    ▲
   │                                           └──resolved──┘  │    │
   │                                                             │    │
Goal ──has──▶ Step ──triggers──▶ ActionProposal                  │    │
   │  ▲                                                ┌───────┘    │
   │  │                                                │            │
   │  └──loop──▶ Run ──produces──▶ Artifact              │            │
   │                                           │            │            │
   └──owned──▶ Bot (Agent) ──has──▶ Capability    │            │            │
                                             ▼            ▼            ▼
                                         Policy ──classifies──▶ Risk (read|write|destructive)

CONTROL: AuditEntry ──chains──▶ AuditEntry (prevHash)
         ├── approves ──▶ Approval
         ├── records ──▶ Action / ActionProposal
         └── records ──▶ Goal / Run / Adapter / Provider / ...

CONNECT: Adapter ──wires──▶ Provider (BRAIN)
CONNECT: Plugin ──extends──▶ Agent / Bot
```

### §3.4 Provenance rules

- Every rendered fact MUST trace to an object with `id`, `provenance`, and `chainSeq` where applicable (00-KERNEL principle 3).
- If the fact is not in the ledger (no matching `AuditEntry`), the UI marks it **unverified** — never silently displayed as trusted.
- Chain integrity: every render of chain-dependent data calls `chain.verify()` before display; a TAMPERED seal is surfaced as a persistent, non-dismissible warning.
- **Audit-first provenance:** every object that participates in a state transition MUST carry a back-reference to the `AuditEntry.seq` that sealed the transition; objects that cannot produce this back-reference are rendered as *pending-audit* (dimmed, with a chain-wait indicator).
- **Freshness gate:** objects whose last `AuditEntry.ts` is older than the session TTL are flagged *stale* and re-fetched before the next interaction — never displayed as current without a fresh chain check.
- NEW objects introduced by this spec (Run, Step, Surface) MUST define their provenance anchoring before they are rendered in production; until then they are flagged unverified.

### §3.5 Adapter and Provider lifecycle summary

Adapters and Providers are the external-facing objects; their lifecycle is simpler than the governed arc but still audit-bound.

**Adapter** states: `registered` → `active` (enabled) ↔ `disabled`; terminal: `deleted`. Tests produce `adapter_tested` (ok|fail|blocked) without changing the enabled state. Secrets are stored as `{hash, length, fingerprint}` only — never a value (PLATFORM-ABI rule 5).

**Provider** states: `ok` ↔ `httpStatus?` (live probe); `provider_live_probed` and `provider_live_access_denied` are the audit events. A Provider marked `ok: false` is surfaced with a degraded badge in the BRAIN domain; it MUST NOT be silently hidden — operators need to see degraded intelligence sources (00-KERNEL principle 5).

### §3.6 Object lifecycle overview

The governed arc in ASCII — every arrow is an audited transition:

```
Session ──open──▶ Chat ──propose──▶ ActionProposal
                                          │
                     ┌────────────────────┴────────────────────┐
                     ▼                                         ▼
               classify()                               classify()
                     │                                         │
              allow │     needs_approval │           deny │
                     ▼                         ┌───────────┘
               Action ──execute──▶ Artifact    Approval ◀─request──┘
                                          │          │
                                     approve│     deny│expire
                                          ▼          ▼
                                     execute   (done)
                                     (artifact)

Goal ──add──▶ active ──loop──▶ Run ──tick──▶ Step ──decide──▶ done|denied
  │                                              │
  ├─ pause ◀─────────────────────────────────────┤
  ├─ resume ─────────────────────────────────────┤
  └─ clear ──────────────────────────────────────┘
     (terminal)
```

Every arrow above emits a `gw._audit(payload)` entry whose `type` is drawn from the 71-type audit vocabulary (§00-KERNEL.md); the `prevHash` chain binds each entry to its predecessor so the full arc is verifiable end-to-end.

---

## §4 Surface architecture

### §4.1 Formal definition of a Surface

A **Surface** is a tuple `S = ⟨Q, I, A, R, E⟩` where:
- **Q** = query over objects (a filter/slice of the object space, e.g. "pending approvals" = {a ∈ Approval | a.state = pending})
- **I** = intent profile (the user intent this surface serves: observe | propose | decide | diagnose | compose | review)
- **A** = affordances (interactive capabilities the surface exposes: approve | deny | interrupt | edit | navigate | watch)
- **R** = risk behavior (how this surface reacts to risk classes: block | warn | allow | gate-on-approval)
- **E** = state map {empty: ..., loading: ..., error: ...} — each a rendered fallback, never a dead end (00-KERNEL principle 6)

### §4.2 Surface catalog (kernel vocabulary expanded)

| Surface | Inputs | Affordances | Risk behavior | Empty | Loading | Error |
|---|---|---|---|---|---|---|
| **Feed** | intent=observe; domain filter | watch, navigate | allow all, surfaces risk badges | "Nothing pending — all clear" | skeleton stream | "Feed unavailable — check chain seal" |
| **Board** | intent=review; work-state filter | sort, filter, navigate | warn on high-risk items | "No work objects in this view" | card grid shimmer | "Board data incomplete" |
| **Graph** | intent=explore; seed object | zoom, traverse, inspect | allow; highlights cross-domain edges | "No connections yet" | node-spring layout | "Graph could not be built" |
| **Detail** | intent=review; object id | navigate, edit (gated), prove | risk-badge per field; secret fields redacted | "Object not found or unverified" | full-height skeleton | "Object unverifiable — chain gap" |
| **Composer** | intent=compose; draft text | propose, submit, preview | blocks destructive without approval gate | "What would you like to do?" | type-ahead spinner | "Proposal rejected — check capabilities" |
| **Diff** | intent=review; before/after object refs | navigate, inspect | warn on destructive diffs | "No changes recorded" | diff skeleton | "Before/after anchors missing" |
| **EvidencePanel** | intent=review; action/approval id | trace, verify | always-show chain hash | "No evidence yet" | chain-walk spinner | "Chain verification failed" |
| **Queue** | intent=decide; pending approvals | approve, deny, delegate, snooze | gate high-risk behind approval | "Queue empty — nothing needs you" | FIFO reorder spinner | "Queue unavailable — retry" |
| **Timeline** | intent=review; object id | scrub, jump-to-event | allow; marks interrupt points | "No events recorded" | time-axis skeleton | "Timeline data missing" |
| **Terminal** | intent=diagnose; run id | watch, interrupt, copy | warn on destructive commands | "No active stream" | raw stream skeleton | "Stream disconnected — reconnect" |
| **Modal/Drawer** | intent=interrupt; focus context | confirm, cancel, escalate | MUST gate on risk + capability | n/a (overlays) | overlay fade | "Action blocked by policy" |

### §4.3 Composition rules — decision function

**Decision function:** `Surfaces(intent, workState, risk, permissions, capabilities, device, attention) → {Surface}`

The composition engine evaluates the tuple against the surface catalog and returns the *minimal sufficient set* of surfaces that satisfy the intent while respecting risk gating and capability filtering. Surfaces are never hidden entirely — they fall back to their empty/loading/error state if their query returns empty, but a surface whose *risk gate* the user cannot clear is omitted (not shown at all) rather than shown in a blocked state.

**Rules (MUST / SHOULD / MAY):**
- **MUST** include at least one surface whose intent matches the declared `intent`.
- **MUST** omit any surface whose `risk` gate exceeds the user's `risk` authority (00-KERNEL principle 4: risk is a first-class axis).
- **SHOULD** include an `EvidencePanel` whenever `intent = decide` or `intent = diagnose` (traceability).
- **SHOULD** include a `Queue` when `workState = awaiting-approval` and the user is an Approver/Operator.
- **MAY** include `Terminal` when `intent = diagnose` and `device = desktop`.
- **MUST NOT** show a `Composer` affordance unless `capabilities` includes the relevant write/capability.
- **MUST** surface the `(Identity, Role, Scope)` tuple in chrome whenever any surface is composed.

### §4.4 Worked scenarios

**Scenario 1 — Knowledge worker morning check**
- Tuple: `{intent: observe, workState: idle, risk: low, permissions: member, capabilities: [fs.read, chat], device: desktop, attention: ambient}`
- **Surfaces:** Feed (observe, low-risk, badge risk), Timeline (ambient scan of recent objects)
- Rationale: observe intent + low risk → read-only surfaces; ambient attention → compact summaries, no modals. Composer excluded (no compose intent). Queue excluded (no pending approvals expected).

**Scenario 2 — Operator debugging a failed run**
- Tuple: `{intent: diagnose, workState: error, risk: medium, permissions: operator, capabilities: [fs.read, fs.write, shell.run, interrupt], device: desktop, attention: foreground}`
- **Surfaces:** Detail (Run), Terminal (diagnose, desktop + interrupt capability), Diff (before/after of run state), EvidencePanel (trace the failure chain), Timeline (event sequence), Composer (compose a fix)
- Rationale: diagnose + error → execution surfaces; foreground + interrupt capability → Terminal with interrupt affordance; medium risk → Terminal allowed (operator authority), no destructive gate.

**Scenario 3 — Approver triaging high-risk**
- Tuple: `{intent: decide, workState: awaiting-approval, risk: high, permissions: approver, capabilities: [approval.decide, *], device: desktop, attention: foreground}`
- **Surfaces:** Queue (decide, pending approvals), Detail (ActionProposal), EvidencePanel (chain trace for the proposal), Diff (what changes), Modal/Drawer (confirm — gated on high risk + approval.decide capability)
- Rationale: decide + high risk → full evidence surfaces + gated confirmation modal; Queue surfaces the worklist; Composer excluded (approver doesn't propose — only decides). `MUST` include EvidencePanel per §4.3 rule.

### §4.5 Acceptance criteria (15+ testable statements)

1. Every object deep link follows `/d/<domain>/o/<type>/<id>` and resolves to a stable URI.
2. `chain.verify()` is called before any surface that displays chain-dependent data; TAMPERED renders a persistent warning.
3. Any object without a matching `AuditEntry` is rendered with an "unverified" badge — never plain.
4. The `(Identity, Role, Scope)` tuple is visible in chrome for every composed surface set.
5. A surface whose risk gate exceeds the user's risk authority is omitted entirely, not shown in a blocked state.
6. `Surfaces(intent=observe, risk=low)` returns Feed + Timeline and excludes Composer, Modal, Terminal.
7. `Surfaces(intent=decide, risk=high)` includes EvidencePanel and a risk-gated Modal/Drawer.
8. `Surfaces(intent=diagnose, device=mobile)` excludes Terminal (desktop-only).
9. The Queue surface appears iff `workState = awaiting-approval` AND the user holds Approver or Operator role.
10. Composer affordances are hidden unless `capabilities` includes the relevant write capability.
11. Every transition in §3.2 emits at least one audit event from the 71-type vocabulary; no transition is silent.
12. A Run with no matching `AuditEntry` for its lifecycle is flagged unverified.
13. The back button returns to the previous object deep link context (graph-walk semantics, not page id).
14. Switching scope in the workspace switcher re-composes the surface set within one render cycle.
15. Each surface in §4.2 renders its empty, loading, AND error state — no dead-end screen (principle 6).
16. `approval_resolved` after `needs_approval` folds back into ActionProposal state within one audit-stream emission.
17. Destructive proposals (risk = destructive) MUST pass through an approval gate before `action_executed`.
18. Composer surfaces a policy `classify()` + `decide()` preview inline before the user submits (00-KERNEL principle 5: human can always see what an agent is doing, why, with what data).
19. The NOW feed MUST surface the three most urgent items by risk-first sort (Queue-ordered, FIFO by risk per kernel "Queue" definition).
20. Back/forward graph-walk MUST not exceed O(1) per navigation step (history keyed by `(domain, type, id)` tuples).
21. Every surface tuple evaluation MUST be deterministic: identical inputs produce identical surface sets within a single render.
22. Surfaces omitted by the decision function MUST be recorded with an `omittedBecause` reason (risk | capability | intent | device) for debug and developer-mode inspection.
23. A `pending-audit` object MUST not block the render — it is dimmed with a chain-wait indicator, not a hard error.
24. A goal whose step reaches `denied` MUST surface the denial reason inline on the Step Detail surface and bubble to the Goal Timeline (never silently swallowed).
25. A Provider marked `ok: false` MUST display a degraded badge in the BRAIN domain — degraded intelligence sources are never silently hidden (00-KERNEL principle 5).
26. Adapter `testResult: blocked` MUST render as a distinct warning from `testResult: fail` — blocked implies a policy refusal, fail implies a connectivity or credential issue.
27. Every render of the NOW feed MUST include the `chain.verify()` seal status for each item — an unverified item is marked, a TAMPERED item is flagged as critical.
28. The `omittedBecause` reason for a omitted surface MUST be one of: `risk` | `capability` | `intent` | `device` — any other value is a composition-engine bug.

### §4.6 Dynamic UI composition reference (§5 forward link)

The composition engine is referenced as §5 in the kernel (00-KERNEL.md §5); this spec defers the full algorithm to §5 but anchors these bindings now:
- Every surface tuple is evaluated against the catalog in §4.2 at render time.
- Surfaces not matched by the decision function are still registered in the composition plan as `omitted` (with a `omittedBecause` reason: risk | capability | intent | device) — useful for debug/developer mode.
- The engine MUST be deterministic: same tuple → same surface set, given the same catalog. Non-determinism (e.g., LLM-ranked ordering) is reserved for §5 and is not permitted in the base composition function.

> **BACKEND GAP:** The Dynamic UI Composition engine (§5) is not yet implemented; the `tgPanels` mount-declared panels (PLATFORM-ABI) are a simpler, mount-driven ordering. The full composition function is a wave-B implementation task.

---

**END OF FILE**
