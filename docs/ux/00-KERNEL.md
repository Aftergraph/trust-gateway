# UX SPEC KERNEL — canonical vocabulary (READ FIRST, do not restate)

Every spec document in docs/ux/ binds to this file. Terms defined here are
STABLE: use them verbatim. New terms you introduce must be marked `NEW:` on
first use and added to your own section's glossary. Language: English body +
a 2–4 sentence Danish `RESUMÉ` block at the top of each document (repo
convention; the product owners are Danish).

## The product

Trust Gateway is a governed agentic operating console: humans and agents
work in the same session/object space, every action is policy-gated and
hash-chained into an audit ledger, and the UI is the human's control surface
over that machinery. The console is not a chat app with extras; it is an
operations surface where chat is one of several entry points.

## Design principles (normative)

1. **Objects persist. Surfaces adapt. Capabilities extend. Agents act. Humans retain control.**
2. No static page-first dashboards; no generic card grids. UI is composed
   from intent, context, work-state, risk, permissions, capabilities,
   device, and attention.
3. Every rendered fact traces to an object with an id, provenance, and
   chain sequence number where applicable. If it is not in the ledger, the
   UI marks it unverified.
4. Risk is a first-class visual axis, not a settings afterthought.
5. The human can always see what an agent is doing, why, with what data,
   and can interrupt.
6. Failure is a state of the object, never a dead-end screen.

## Top-level domains (navigation roots)

| Domain | Contains | Current code anchor |
|---|---|---|
| NOW | live feeds, pending approvals, running work, attention queue | SSE hub, approvals |
| CHAT | sessions, messages, deep-chat, transparency pages | /v2/chat*, /h/<token> |
| WORK | goals, missions, loops, runs, schedules | goals panel, continuity |
| AGENTS | bots, builder, roles, teams/rooms | /v2/bots, builder, rooms |
| BRAIN | models, providers, LLM loops, memory policy | llm-loop, /v2/providers/live |
| OUTPUT | artifacts, history, playground results, exports | artifacts, history, playground |
| CONTROL | policy, approvals, trust, risk, audit chain | policy.js, approvals, chain verify |
| CONNECT | adapters, integrations, webhooks, telegram, MCP/plugins hub | adapters, hub |
| SYSTEM | deploy, health, self-repair, storage, CLI/TUI surfaces | deploy, selfrepair |

## Canonical objects (domain model — extend fields in your section, never rename)

- **Session** {id, name, createdAt, participants[], turns[]} — chat context.
- **Message** {role, author, text, trustScore, untrusted?} — trust flags from src/gateway/trust.js.
- **ActionProposal** {tool, args, origin: human|llm|loop, risk, decision?} — model/human proposed action, pre-decision.
- **Action** {id, proposal, decision: allow|deny|needs_approval, result?, auditSeq} — governed execution record.
- **Approval** {id, action, requestedBy, resolvedBy?, state: pending|approved|denied|expired} — src/gateway/approvals.js.
- **Goal / Mission** {id, intent, steps, loop?, status} — persistent unit of work.
- **Run** {goalId?, engine, startedAt, exitCode?, artifacts[]} — one execution.
- **Artifact** {id, kind, origin, jailPath?, publicRef?} — outputs the agents produce.
- **AuditEntry** {seq, ts, payload, prevHash} — chain element; the UI's ground truth.
- **Agent (Bot)** {name, role, capabilities[]} — worker|operator today; spec may propose richer roles.
- **Capability** — grantable verb/scope (fs.read, approval.decide, *…).
- **Policy** — classify/decide rules; risk classes read|write|destructive.
- **Adapter** {id, kind, config, secrets: fingerprint-only} — CONNECT objects.
- **Provider** {name, surface: llm|voice|telegram|openai-compat, ok, httpStatus?, detail} — from providers-live.
- **Surface** — a composed view over objects (see surface vocabulary below).

## Role model (from product owner, normative)

Identity + Role + Scope + Capability + Policy — one identity holds
different roles per workspace/scope; least privilege; temporary and
delegated permissions must be expressible; every grant/revoke is an audit
event. The 12 target roles: Member, Operator, Approver, Agent Builder,
Workflow Builder, Manager/Team Lead, Workspace Admin, Security/Governance
Admin, Organization Owner, Developer/Platform Admin, Auditor/Reviewer,
External Collaborator/Guest. Current system knows only worker/operator
bot roles — mapping the 12 onto the existing model is a spec task, not an
assumption you may silently make.

## Surface vocabulary (composition primitives — refine, don't reinvent)

Feed (append-only stream) · Board (state-over-time grid of work objects) ·
Graph (relationship view) · Detail (single object, full provenance) ·
Composer (input that produces objects) · Diff (before/after evidence) ·
EvidencePanel (chain trace for one decision) · Queue (attention worklist,
FIFO by risk) · Timeline (time-axis of one object) · Terminal (raw stream) ·
Modal/Drawer (interrupting focus, risk-gated).

A screen = composition of surfaces chosen by the Dynamic UI Composition
engine (§5); sections 6–8 define what surfaces appear for what intent.

## Requirement levels

MUST / MUST NOT / SHOULD / MAY (RFC-2119 style). Every section ends with
Acceptance criteria as testable statements; §20 rolls them into the
release plan.

## Grounding rules for all spec authors

- Read docs/v2/PLATFORM-ABI.md first; the platform is real (611 tests,
  71 audit types, 13 console tabs). Propose against its seams: mounts,
  executors, TG_PANELS, chain payloads.
- Every capability you assume from the backend that does NOT exist yet is
  marked `BACKEND GAP: <one-line description>` in your section's summary.
  The spec is free to demand new backend, it is not allowed to pretend.
- No mockup images; wireframe-level ASCII or tables only.
- Cite concrete files/paths when describing current state.
