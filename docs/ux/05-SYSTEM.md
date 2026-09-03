# SYSTEM — Search, Command, Extensions & Production Rollout

> **RESUMÉ:** Søgning og kommandogang er den operative rygrad i Trust Gateway: ét felt (⌘K) som OS-level indgangsport til hele objektgrafen, med slash-kommandoer der lander på reelle mounts, FTS5-søgning over audit-kæden, fuzzy opløsning af transparens-tokens, og naturlig-sprog-til-intent-faldback til den deterministiske ChatPlanner. Udvidelsessystemet er platformens egen udvidelsesmodel: mount-deklarerede executors + TG_PANELS som sanktioneret overfladeregister, panel-manifest-schema med capability-filtrering, MCP/plugin-hub som installationsflade, og CONNECT-domænets adaptertyper som data-drevet udvidelse. Produktionen rulles ud i fem faser uden big-bang-omskrivning.

This document defines the search & command system (§18), the extensions/capabilities model (§19), and the acceptance criteria + production rollout plan (§20). It builds on the canonical vocabulary in §00-KERNEL and the platform ABI in PLATFORM-ABI.md. Every requirement is tagged MUST / SHOULD / MAY; every section ends with testable acceptance criteria; §20 rolls them into the release plan.

---

## §18 Search & command

The console's single OS-level entry point is a unified palette (⌘K). It sits above the 13-tab router and exposes the whole object graph — commands, search, object resolution, and intent — from one input surface. No modal is deeper than one keystroke from any context.

### 18.1 The palette (⌘K)

MUST. Pressing ⌘K (or Ctrl+K on non-macOS) anywhere in the console opens the palette overlay. The palette is **context-aware**: it surfaces different suggestion sets depending on which panel (or no panel) is foregrounded. The palette itself is rendered by the composition engine (§5) and is not a hardcoded DOM element — it is a surface registered in TG_PANELS with `domains: ['global']`.

SHOULD. The palette remembers the user's invocation context (last used panel, last command prefix) to rank suggestions. This is a SHOULD because it depends on telemetry data that does not exist yet (§20.4 backlog).

MAY. The palette supports a "plain text" mode where the first non-slash token is sent as a chat message (matches the TUI's `SLASH` set logic in `src/cli/tui.js`). This is the `chat` intent fallback when no command prefix matches.

### 18.2 Commands — slash-style verbs mapped to real mounts

The palette's command bar accepts slash-prefixed input. Each command resolves to a real mount endpoint on the gateway. The v1 command table:

| Command | Args schema | Required Capability | Mount / handler | Auth |
|---|---|---|---|---|
| `/approve <id>` | `{id: string}` | `approval.decide` or `*` | `POST /v1/approvals/:id/approve` (`src/gateway/client.js`) | bearer |
| `/deny <id>` | `{id: string}` | `approval.decide` or `*` | `POST /v1/approvals/:id/deny` (`src/gateway/client.js`) | bearer |
| `/run <tool> <args?>` | `{tool: string, args?: object}` | `tool.<class>` per policy classification | `POST /v1/actions` (`src/gateway/server.js._postAction`) | bearer |
| `/model <provider>` | `{provider: string}` | `provider.select` (CURRENTLY: no dedicated mount — see BACKEND GAP) | `GET /v2/providers/models` (`mounts/45-providers.js`) | bearer |
| `/interrupt <actionId>` | `{actionId: string}` | `control.take` (CURRENTLY: no interrupt endpoint — see BACKEND GAP) | `POST /v2/computer/:id/control` (`mounts/42-computer.js`) | bearer |
| `/verify` | none | `*` (read-only) | `GET /v1/audit/verify` (`src/gateway/client.js`) | bearer |
| `/resume [id]` | `{id?: string}` | `goal.resume` | `POST /v2/goals/:id/resume` (`mounts/50-continuity.js`) | bearer |
| `/search <query>` | `{query: string, limit?: number}` | `*` (read-only) | `GET /v2/search?q=…&limit=…` (`mounts/10-search.js`) | query token |
| `/status` | none | `*` (read-only) | `GET /healthz` + `GET /v1/audit/verify` | bearer |
| `/chat <message>` | `{message: string}` | `*` | `POST /v2/chat` (`mounts/20-chat.js`) — proposals only | bearer |
| `/goal add <text>` | `{text: string}` | `goal.create` | `POST /v2/goals` (`mounts/50-continuity.js`) | bearer |
| `/goal pause|resume|clear <id>` | `{id: string}` | `goal.*` on owner | `mounts/50-continuity.js` slash dispatcher | bearer |
| `/loop start|stop <id>` | `{id: string}` | `goal.loop` on owner | `mounts/50-continuity.js` slash dispatcher | bearer |
| `/audit [since]` | `{since?: number}` | `*` (read-only) | `GET /v1/audit?since=…` | bearer |
| `/pending` | none | `*` (read-only) | `GET /v1/approvals` | bearer |
| `/model` (list) | none | `*` | `GET /v2/providers/models` + `GET /v2/providers/probe` | bearer |

MUST. Every command in the palette table maps to a real, tested mount. The palette must NOT invent commands that do not resolve to a gateway endpoint. The `src/cli/commands.js` module is the canonical source of truth for CLI commands; the palette must cover the same operations.

SHOULD. The palette exposes `/run` as a structured form (tool picker from `gw.bots[bot].capabilities`, args built from the capability schema) rather than a free-text field. This requires the capability schema to be queryable at runtime — a BACKEND GAP flagged in §19.2.

MAY. Custom slash commands from extensions (§19) are composable into the palette's command list when the extension declares them in its manifest.

### 18.3 Search — FTS5 over the unified index

The search index is REAL today. `src/gateway/search.js` performs substring matching over canonical payload JSON via `searchChain(chain, q, {limit})`. The mount `10-search.js` exposes `GET /v2/search?q=<query>&limit=<n>` with query-token auth (because browser EventSource cannot set headers).

**Unified index scope** (the search indexes across these object classes):

| Index class | Content | Currently searchable |
|---|---|---|
| **sessions** | ChatPlanner session messages, participant list, turn count | Via `chat_action` audit entries (seq, ts, payload) |
| **objects** | Goal, Mission, Run, Artifact, Approval, Adapter | Via their audit lifecycle entries (`goal_*`, `artifact_*`, `approval_*`, `adapter_*`) |
| **artifacts** | `{id, kind, origin, jailPath?, publicRef?}` | `artifact_created`, `artifact_updated`, `artifact_update_denied` |
| **audit entries** | All 71 `{type, seq, ts, payload, prevHash}` entries | Every entry's JSON-serialized payload — full-text today |

SHOULD. When `SqlChain` lands (`src/gateway/sql-chain.js` already has the FTS5 virtual table scaffold at line 94 — `CREATE VIRTUAL TABLE IF NOT EXISTS chain_fts USING fts5(...)`), `searchChain` swaps from substring matching to FTS5 queries. The `fts` boolean flag on the chain object (`sql-chain.js` line 30) gates this. The search mount and the CLI `/search` command are agnostic to the backend — they call `searchChain`, so the swap is transparent.

MUST. The palette search input must invoke the same `GET /v2/search` endpoint as the History panel's inline search (`app/panels/history.js` `fetchSearch`). No divergence between palette and panel search.

### 18.4 Result classes — typed, chain-seq jump

Search results MUST be typed by `payload.type`. The palette renders result groups by type, each group labeled with the audit event type. Result classes (the set the UI must handle):

- **decision** — `action_decision`, `action_executed`, `action_executed_after_approval`
- **approval** — `approval_requested`, `approval_resolved`, `approval_forbidden`
- **goal** — `goal_*` family (added, cleared, completed, paused, resumed, stepped, etc.)
- **artifact** — `artifact_created`, `artifact_updated`, `artifact_update_denied`
- **adapter** — `adapter_registered`, `adapter_updated`, `adapter_deleted`, `adapter_tested`
- **plugin** — `plugin_installed`, `plugin_enabled`, `plugin_disabled`, `plugin_uninstalled`, `mcp_registered`
- **chat** — `chat_action`, `chat_action_executed`
- **computer** — `computer_frame`, `computer_control_denied`, `computer_session_created`
- **auth** — `auth_rejected`
- **misc** — all other `payload.type` values

MUST. Each result item renders its `seq` number prominently — this is the chain-seq that drives the chain-seq jump (§18.4).

**Chain-seq jump**: selecting a search result scrolls the active panel to the corresponding chain sequence number. In the History panel this is a direct scroll-to-entry; in any other panel it deep-links to the object's timeline view at that seq. The seq is the canonical, globally-unique pointer into the audit chain. The palette MUST display `seq`, `ts`, `hash (first 8 hex)`, and `payload.type` for each hit, in that order.

### 18.5 Fuzzy object-id resolution

MUST. The palette accepts two forms of object identifier and resolves them to the object's detail view:

1. **Seq number** — a bare integer (e.g., `42`) resolves to the audit entry at that chain sequence. The palette displays the entry's `payload.type` and the chain position. Pressing Enter navigates to the Timeline surface for that object.

2. **8-hex transparency token** — exactly 8 hex characters matching `/^[0-9a-f]{8}$/` (the same regex as `mounts/90-transparency.js` line 40). The palette calls `GET /h/<token>` to resolve the token to a session. If the token is valid and scoped to a known session, the palette navigates to the transparency page for that session. If unknown, the palette shows "session not found" — the anti-enumeration guarantee (unknown token and non-existent session render identical 404 bytes) is enforced server-side, but the palette MUST NOT distinguish between the two cases client-side either.

SHOULD. The fuzzy resolver also accepts partial matches: typing the first 4 hex characters of a token + `…` triggers a fuzzy scan across recent sessions. This is a SHOULD because it requires a server-side partial-token lookup that does not exist today (BACKEND GAP: the transparency token index is not queryable by prefix).

MAY. The palette resolves bot names (`@botname`) to the bot's detail panel via `GET /v2/bots` projections (name, role, capabilities only — no tokens, per ABI rule 5).

### 18.6 Natural-language→intent fallback to the planner

MUST. When the palette input does NOT match any slash command (no `/` prefix, or the prefix does not resolve), it falls back to the deterministic ChatPlanner (`src/gateway/chat.js`). The ChatPlanner is **deterministic — no LLM** — and its `INTENTS` array (`chat.js` lines 8–17) maps natural language to intents:

- `/^\s*(help|what can you do)\s*$/i` → `kind: 'help'`
- `/^\s*(status|report|how are (things|the bots))\s*$/i` → `kind: 'status'`
- `/\b(list|show)\s+(the\s+)?(pending|approvals)\b/i` → `kind: 'listPending'`
- `/\b(delete|remove|wipe|drop)\s+(.+)$/i` → `kind: 'propose', tool: fs.delete:…`
- `/\b(run|execute|shell)\s+(.+)$/i` → `kind: 'propose', tool: shell.run`
- `/\b(write|save|create)\s+(file\s+)?([^\s:]+)\s*:?\s*(.*)$/i` → `kind: 'propose', tool: fs.write:…`
- `/\bread\s+(file\s+)?([^\s]+)$/i` → `kind: 'propose', tool: fs.read:…`
- `/^\s*(hi|hello|hey)\s*$/i` → `kind: 'greet'`

The ChatPlanner `plan()` method returns `{reply, actions}` where `actions` are `ActionProposal` objects (see KERNEL canonical objects). **Honest constraint: the planner produces proposals only, never direct execution.** This is enforced by the llm-loop governance principle documented in `docs/standards/AI-GOVERNANCE.md` §6 and `llm-loop.js`: model output is UNTRUSTED TEXT; it may PROPOSE tools through `classify`/`decide` + `gw.approvals` — never executed directly. The deterministic ChatPlanner follows the same path: `propose → classify → decide → approval gate → executor`. The palette MUST display the planner's `reply` as a chat-like response and surface each `action` with its `decision` state (⏸ needs_approval, ✓ allow, ✗ deny).

MUST. The palette's NL→intent flow must NEVER bypass the approval gate. If `decide()` returns `needs_approval`, the palette queues the approval in the NOW panel and displays the pending approval with its TTL. The user must explicitly `/approve <id>` or `/deny <id>` — there is no auto-approve path from the palette.

SHOULD. The palette shows a subtle distinction between "command" (slash-prefixed, maps to a mount) and "chat" (NL, goes to the planner) with a visual indicator in the result type label. This is a SHOULD because it helps users understand the intent boundary; it is not strictly required for correctness.

### 18.7 Keyboard map

Three keyboard contexts: **global**, **queue**, and **palette**. The table below defines which keys are active in each context.

| Key combo | Global context | Queue context | Palette context |
|---|---|---|---|
| ⌘K / Ctrl+K | Open palette (focus command input) | Open palette (focus command input) | — (already open) |
| Esc | Close any open modal/drawer | Dismiss current queue item highlight | Close palette |
| Enter | — | Execute selected queue item | Submit command / select suggestion |
| ↑ / ↓ | — | Navigate queue items | Navigate suggestion list |
| ⌘/Ctrl+N | — | Create new queue item (New approval form) | — |
| ⌘/Ctrl+F | — | — | — (no native find; palette search is the mechanism) |
| / | Focus palette with `/` prefix pre-typed (command mode) | Focus palette with `/` prefix | — |
| Tab | Cycle focus: palette → main panel → status bar | Cycle focus within queue | Cycle suggestions |
| Space | — | Toggle queue item checkbox | — |
| ⌘/Ctrl+Shift+S | — | — | Search (open palette pre-typed with `search`) |

MUST. The keyboard map is enforced by a single keydown handler in `app.js` that dispatches to the active context. No panel may install its own global keydown listener that conflicts with this map (the composition engine must validate this at mount time).

SHOULD. Custom keybindings from extensions are composable via the manifest's `keybindings` field (see §19.3), subject to the global keyboard map conflict check.

---

## §19 Extensions/capabilities

The platform IS its extension model. Extensions declare what they can do (capabilities), what surfaces they use (surfaces), and what domains they serve (domains). The composition engine's capability filter gates which extensions appear where.

### 19.1 Mount-declared executors + TG_PANELS as the sanctioned surface registry

**Mount-declared executors** (PLATFORM-ABI.md wave C addendum #1): a mount file may export `executors: [{re, make(gw)}]`. The Gateway constructor registers them via `gw.registerExecutor(re, make(gw))`. New tool namespaces NEVER touch `bin/gateway.js` or `server.js`. The executor resolution order (server.js lines 93–99): registered executor wins (synthetic v2 tools), else the jailed dispatcher. Current executors in the codebase:

| Executor regex | Module | Purpose |
|---|---|---|
| `/^harness\.(build|run):/` | `mounts/55-harness.js` | synthetic harness build/run tools |
| `/^worktree\.(snapshot|remove|list)/` | `mounts/55-harness.js` | worktree snapshots |
| `/^playground\.run:(js|html)$/` | `mounts/80-playground.js` | playground execution |
| `/^web\.(fetch|search):/` | `mounts/65-web.js` | web tools |
| `/^computer\.(control|session):/` | `mounts/42-computer.js` | computer session operations |

**TG_PANELS** is the sanctioned surface registry. Every panel registers via `(window.TG_PANELS = window.TG_PANELS || []).push({id, title, render})`. The core tab router (`app/panels/core.js`) scans this array on every tab switch and lazy-mounts the matching `render(hostEl)` into `<section id="pv-{id}">`. The current 13 panels: console, rooms, artifacts, goals, builder, hub, providers, providers-live, history, computer, playground, voice, integrations.

MUST. Extensions declare their surface as `surfaces` in the manifest. The composition engine must filter panels by `domains[]` match against the current navigation root. A panel with `domains: ['NOW']` MUST NOT render on the CHAT tab.

SHOULD. Panels can be lazy-mounted (mounted when first navigated to) or eagerly-mounted (mounted on page load). The manifest declares the mode. Lazy is the default for performance; eager is allowed for panels that must be ready before the first navigation (e.g., the console panel).

### 19.2 Versioning rules and the capability-scoped API surface

**Extension manifest versioning**: every manifest declares `version` in semver (`x.y.z`). The composition engine tracks the installed version and prevents downgrades without explicit operator confirmation. Patch versions (`z` increment) may auto-update; minor (`y`) requires confirmation; major (`x`) requires a full re-approval workflow.

**Capability-scoped API surface** — what an extension panel gets:

The panel receives the shared `window.TG` object, which currently exposes:

| Capability | Method | Scope | Current status |
|---|---|---|---|
| `TG.api` | `api(path, opts?)` | read/write to any mounted endpoint | **PRESENT** — but it uses the operator's bearer token |
| `TG.el` | `el(tag, cls?, text?)` | DOM element factory (textContent only) | **PRESENT** |
| `TG.token` | `token()` | returns current bearer token | **PRESENT** |
| `TG.authed` | `authed()` | returns boolean | **PRESENT** |
| `TG.refresh` | `refresh()` | refreshes pending + bots | **PRESENT** |
| `TG.onAudit` | `onAudit(fn)` | subscribes to SSE audit stream | **PRESENT** |

BACKEND GAP: `TG.api` currently reaches the gateway with the **operator's bearer token** — it is NOT scoped to the extension's declared capabilities. An extension panel CAN make arbitrary API calls using the operator's token, including `raw fetch` with operator credentials. This violates the principle that extensions MUST NOT reach raw fetch with operator tokens. The capability-scoped API surface must be redefined so that `TG.api` proxies through the extension's declared capabilities, and any attempt to make a raw `fetch()` call with the operator token is blocked (or at minimum, flagged). **This is a BACKEND GAP that must be closed before extensions are enabled in production.**

SHOULD. `TG.session` — a capability-scoped session accessor that returns only the current session's data the extension is authorized to see — is planned but does not exist yet. The session store is internal to `ChatPlanner` (`chat.js`). Exposing it requires a new `GET /v2/sessions/:id` endpoint with capability gating. **BACKEND GAP.**

MUST. No extension panel may call `fetch()` directly with the operator token. All API calls MUST go through `TG.api`, which in the patched version MUST validate the call against the extension's declared `capabilities[]`. Any panel that calls `fetch()` directly MUST be flagged at mount time by the composition engine's validator.

### 19.3 Panel manifest schema

Every panel — internal or extension — declares a manifest. The composition engine uses this manifest for the capability filter.

```jsonc
// panel-manifest.schema.json (canonical)
{
  "id": "string",           // unique panel id, lowercase slug [a-z0-9][a-z0-9.-]*
  "title": "string",        // display title, 1–64 chars
  "version": "string",      // semver x.y.z
  "domains": ["string"],    // subset of KERNEL top-level domains: NOW, CHAT, WORK, AGENTS, BRAIN, OUTPUT, CONTROL, CONNECT, SYSTEM
  "requiredCapabilities": ["string"], // e.g., ["approval.decide", "goal.create", "fs.read"]
  "surfaces": ["string"],   // composition surface names: Feed, Board, Graph, Detail, Composer, Diff, EvidencePanel, Queue, Timeline, Terminal, Modal/Drawer
  "surfacesUsed": ["string"], // which surfaces this panel actually composes (for the engine's layout computation)
  "keybindings": [          // optional custom keybindings (subject to global map conflict check)
    { "key": "string", "context": "global|queue|palette", "action": "string" }
  ],
  "entry": "string",        // relative .js path without .., e.g. "panels/my-extension.js"
  "lazy": "boolean",        // true = mount on first navigation; false = eager
  "hidden": "boolean",      // true = registered in TG_PANELS but not shown in tab nav (palette-only)
  "required": "boolean"     // true = core panel, cannot be disabled (console, etc.)
}
```

The composition engine's capability filter works as follows: for the current navigation domain `D`, the engine computes `enabled = intersection(panel.domains, [D])`. If `enabled` is empty, the panel is not mounted. Within the enabled set, `requiredCapabilities` are checked against the operator's capabilities (`gw.bots[bot].capabilities`). Missing capabilities hide the panel's action surfaces but not the panel itself (the panel renders a "capability missing" placeholder).

MUST. The manifest schema is validated by `tests/panel-manifest.test.js` (a test that does not yet exist — BACKEND GAP: the validation harness is not built). The composition engine MUST reject panels with invalid manifests at mount time and log the validation error.

SHOULD. The manifest supports a `depends` array declaring other panels or capabilities this panel requires. If a dependency is missing, the panel is not mounted and a "dependency missing" placeholder is shown.

### 19.4 Third-party UI = generated-UI schema from §12 rules

Third-party extensions that provide UI MUST conform to the generated-UI schema defined in §12 of this specification (the composition engine's surface rules). The generated-UI schema dictates:

- Every surface MUST be composed from the surface primitives defined in KERNEL §Surface vocabulary (Feed, Board, Graph, Detail, Composer, Diff, EvidencePanel, Queue, Timeline, Terminal, Modal/Drawer).
- No static page-first dashboards; no generic card grids.
- Every rendered fact traces to an object with an id, provenance, and chain-seq where applicable.
- Risk is a first-class visual axis.
- XSS policy: textContent only, no innerHTML.

MUST. The composition engine validates third-party UI against the §12 rules at mount time. A panel whose render function injects `innerHTML`, renders static card grids, or displays facts without provenance is rejected.

SHOULD. The engine provides a development-mode lint mode that warns (but does not reject) panels that partially violate the §12 rules, to ease third-party onboarding.

### 19.5 MCP/plugin hub as install surface

The plugin hub (`src/gateway/plugins.js`, `mounts/35-plugins.js`) is the install surface for extensions. Modules live under `modules/<id>/` with a `plugin.json` manifest. Installing copies the directory into `data/modules/<id>/`. The hub supports:

| Operation | Endpoint | Audit event |
|---|---|---|
| Install | `POST /v2/plugins` | `plugin_installed` |
| Reject | (validation failure) | `plugin_rejected` |
| Enable | `POST /v2/plugins/:id/enable` | `plugin_enabled` |
| Disable | `POST /v2/plugins/:id/disable` | `plugin_disabled` |
| Uninstall | `DELETE /v2/plugins/:id` | `plugin_uninstalled` |
| MCP register | `POST /v2/plugins/:id/mcp` | `mcp_registered` |
| MCP reject | (validation failure) | `mcp_rejected` |
| MCP unregister | `DELETE /v2/plugins/:id/mcp` | `mcp_unregistered` |

The `plugin.json` manifest schema (from `plugins.js` `validateManifest`, line 48) allows fields: `id, name, version, entry, description, capabilities, secrets, mcp`. The `capabilities` array is the extension's declared capability set — this is what the composition engine's filter checks against.

MUST. The hub's enabled/disabled state is audited (the 71 audit types include `plugin_enabled`, `plugin_disabled`, `plugin_installed`, `plugin_uninstalled`, `plugin_rejected`, `plugins_forbidden`, `mcp_registered`, `mcp_rejected`, `mcp_uninstalled`). The hub panel MUST display the audit trail for every install/enable/disable/uninstall action.

SHOULD. The hub panel provides an "enabled/disabled" toggle per extension, with the state persisted in `data/modules/<id>/state.json`. The state is NOT the same as the manifest — it is a separate file so that enabling/disabling does not modify the install artifact.

MAY. The hub supports skill discovery (markdown docs with frontmatter, `trigger` capped at 57 chars — the platform skill convention from `plugins.js` line 26). Skills are listed in the Hub panel but do not auto-execute.

### 19.6 CONNECT domain adapter kinds as data-driven extension

The CONNECT domain's adapter registry (`src/gateway/adapters.js`, `mounts/70-adapters.js`) defines adapter kinds as a hardcoded list:

```js
const KINDS = ['telegram', 'email', 'webhook', 'http-api', 'calendar'];
```

Each kind has required config keys (`REQUIRED_CONFIG`). The adapter registry is the model for the data-driven extension pattern: **registering a new kind = registry entry + panel form schema**.

**Form-schema convention**: when a new adapter kind is registered, it MUST declare a form schema that the composition engine uses to render the adapter registration form. The form schema follows this convention:

```jsonc
// form-schema convention for adapter kind "x"
{
  "kind": "x",                    // the kind identifier
  "label": "Display Name",        // human-readable label for the form
  "fields": [                     // form fields, rendered in order
    { "name": "string", "type": "text|url|password|select", "label": "string", "required": boolean, "placeholder?: string, "options?: [string] }
  ],
  "secretNames": ["string"],      // names of fields that are secrets (hashed, never logged)
  "probe": {                      // optional probe configuration
    "endpoint": "string",         // relative path for probe
    "method": "GET|POST",
    "expect": "string"            // expected response substring for success
  }
}
```

Registering a new kind adds the kind to `KINDS`, adds its `REQUIRED_CONFIG`, and registers its form schema. The CONNECT panel renders the form dynamically from the schema — no hardcoded form per kind. The `secretNames` fields are stored as SHA-256 hashes only (per the secret-hygiene invariant in AI-GOVERNANCE.md §5).

MUST. The adapter kind registry is queryable at `GET /v2/adapters/kinds` — returning the list of registered kinds with their form schemas. The composition engine uses this to render the "Add adapter" form dynamically.

SHOULD. The adapter probe (`POST /v2/adapters/:id/test`) returns `{result: ok|fail|blocked}` and is audited as `adapter_tested` with `{id, kind, result}` only — no URL, no secret value (confirmed in `mounts/70-adapters.js` line 83).

MAY. Third-party adapters can register their own kind + form schema via the extension manifest's `adapters` field, subject to the same validation as built-in kinds.

---

## §20 Acceptance criteria + production rollout

### 20.1 Cross-cutting acceptance invariants

Every invariant is a traceable acceptance id tied to an owning section. The invariants are drawn from the kernel principles in §00-KERNEL and the AI governance standards in `docs/standards/AI-GOVERNANCE.md`.

| # | Invariant | Must be testable by | Owning § |
|---|---|---|---|
| I1 | Objects are traceable: every rendered fact has an id, provenance, and chain-seq where applicable | §18.3, §18.4: inspect any search result and verify `seq` + `hash` + `payload.type` are present | §18 |
| I2 | No unverified fact renders unmarked: if a fact is not in the audit chain, the UI marks it unverified | §18.4: verify that all displayed facts have a corresponding `seq` in the chain | §18 |
| I3 | Approvals are keyboard-complete: `/approve <id>` and `/deny <id>` work from the keyboard without navigating to the approval queue | §18.2: test `/approve` and `/deny` from palette in any context | §18 |
| I4 | Chain-broken blocks writes: if `GET /v1/audit/verify` returns `{ok: false}`, all write commands (`/approve`, `/deny`, `/run`, `/goal`, `/loop`) MUST be disabled | §18.2: verify commands are gated on chain verify | §18 |
| I5 | 402/429 never dead-end: HTTP 402 (payment required) and 429 (rate limited) responses must display a recoverable error state with a retry option, never a dead-end screen | §18.1, §18.6: palette error handling for all commands | §18 |
| I6 | NL→intent never bypasses the approval gate: every `needs_approval` decision from the planner produces a pending approval, never auto-execution | §18.6: test that planner proposals with `needs_approval` create approvals | §18 |
| I7 | No raw fetch with operator tokens: no extension panel calls `fetch()` directly; all API calls go through `TG.api` | §19.2: runtime validator in composition engine | §19 |
| I8 | Extension capabilities are scoped: a panel can only act on endpoints declared in its `requiredCapabilities` | §19.2: capability filter test | §19 |
| I9 | Adapter secrets are never logged or echoed: `adapter_secret_set` audit payload contains only `{id, name, length}` | §19.6: inspect audit entries | §19 |
| I10 | Old tab IDs redirect during migration: no broken-URL windows | §20.3: verify redirect map | §20 |

### 20.2 Conformance tiers

| Tier | Scope | Definition | Smoke matrix |
|---|---|---|---|
| **A — Platform core** | Today's 611-test console passes an automated smoke per domain | Every domain in the KERNEL top-level domains table must have at least one automated smoke test that exercises the domain's primary mount + panel + audit trail. The 611 tests must remain green. | See §20.3 smoke matrix |
| **B — Composition engine** | The Dynamic UI Composition engine (§5) validates panels against the manifest schema and §12 surface rules | Every panel mount passes schema validation; every third-party UI passes the §12 lint check; the capability filter correctly hides panels whose domains don't match the current navigation root | §19.3 manifest validation + §19.4 §12 lint |
| **C — Extensions API** | Mount-declared executors + TG_PANELS + plugin hub + adapter kinds are fully operational with capability-scoped API surface | All §19 requirements are implemented; `TG.api` is capability-scoped; `TG.session` exists; the form-schema convention is live for all adapter kinds; the plugin hub's enabled/disabled state is fully audited | §19.2 capability-scoped API + §19.5 hub audit + §19.6 adapter kinds |

MUST. Tier A smoke tests are gate 1 for any release. Tier B and C are progressive gates that unlock as the underlying backend gaps close.

### 20.3 Migration plan: 13-tab router → domain model

The current console uses a 13-tab router (`app/panels/core.js` `TABS` array: console, rooms, artifacts, goals, builder, hub, providers, providers-live, history, computer, playground, voice, integrations). The migration to the domain model (§00-KERNEL top-level domains: NOW, CHAT, WORK, AGENTS, BRAIN, OUTPUT, CONTROL, CONNECT, SYSTEM) happens WITHOUT big-bang rewrite, in five phases. Each phase has entry/exit criteria, a kill-switch, a user-visible mid-migration state, and metrics to gate promotion.

#### Phase 0 — Token/theme swap (safe, one PR)

- **Entry**: All 611 tests pass. No feature changes.
- **Work**: Swap the CSS token set and theme variables to the dark-mode design system (§12 rules). Update `app/style.css` and `app/responsive.css`. No tab changes, no behavior changes.
- **Exit**: All 611 tests pass. Visual regression tests pass. The console looks different but behaves identically.
- **Kill-switch**: Revert the CSS PR. No state is affected.
- **What the user sees**: The console's colors change. Tabs, panels, and behavior are identical.
- **Metrics**: visual regression pass rate (100% required).

#### Phase 1 — Pin + queue-first rework of History panel (NOW)

- **Entry**: Phase 0 complete. The History panel is the first panel to be reworked because it maps directly to the NOW domain (audit stream + search).
- **Work**: Reorder `TABS` so History is pinned near the top (NOW domain priority). Add queue-first behavior: pending approvals (`/v1/approvals`) are surfaced as a queue at the top of the NOW domain. The History panel's inline search (`fetchSearch` → `GET /v2/search`) is promoted to the palette's primary search channel.
- **Exit**: History panel renders first in the tab order. The queue (pending approvals) is visible without navigating to a separate tab. Search via palette works end-to-end.
- **Kill-switch**: Revert `TABS` order. The old order is preserved as a feature flag fallback.
- **What the user sees**: The tab order changes: Console (now NOW with queue) moves first, History is prominent, and the search palette (⌘K) can search the audit chain directly.
- **Metrics**: approval latency (time from pending to resolved), follow-along engagement (history panel dwell time), palette usage share.

#### Phase 2 — Domain rail + deep-link URIs

- **Entry**: Phase 1 complete. The tab order reflects the domain model.
- **Work**: Replace the 13-tab `TABS` array with the 9-domain model. Add deep-link URIs: `/now`, `/chat`, `/work`, `/agents`, `/brain`, `/output`, `/control`, `/connect`, `/system`. Old tab IDs redirect: `#rooms` → `#now`, `#artifacts` → `#output`, `#goals` → `#work`, `#builder` → `#work`, `#hub` → `#connect`, `#providers` → `#brain`, `#providers-live` → `#brain`, `#history` → `#output`, `#computer` → `#control`, `#playground` → `#output`, `#voice` → `#connect`, `#integrations` → `#connect`.
- **Exit**: All 9 deep-link URIs resolve to the correct domain panel. Old tab IDs redirect to the new domain IDs (301-style client-side redirect). No 404 windows.
- **Kill-switch**: The redirect map is a JavaScript object in `core.js`. Removing the redirect map disables the old-tab→domain mapping, falling back to the old 13-tab behavior.
- **What the user sees**: The tab bar shows 9 domain labels instead of 13 panel labels. Bookmarked `#history` URLs still work (they redirect to `#output`). The URL bar shows domain paths.
- **Metrics**: SR/keyboard test pass rate, broken-URL window count (target: 0).

#### Phase 3 — Composition engine behind flag

- **Entry**: Phase 2 complete. Deep-link URIs work.
- **Work**: Ship the Dynamic UI Composition engine (§5) behind a feature flag (`?compose=true` or `localStorage.getItem('tg-compose')`). The engine reads panel manifests and composes surfaces dynamically. The old tab-router behavior is the fallback.
- **Exit**: The composition engine is live behind the flag. All panels render correctly via the engine. The old router still works as fallback.
- **Kill-switch**: Remove the `?compose=true` flag or clear the localStorage entry. The old tab-router behavior is restored instantly.
- **What the user sees**: Users with the flag see a dynamically composed UI that adapts to the domain and context. Users without the flag see the existing tab-based UI.
- **Metrics**: palette usage share, follow-along engagement, composition engine render time.

#### Phase 4 — Extension manifests

- **Entry**: Phase 3 complete. The composition engine is behind a flag and working.
- **Work**: Ship the extension manifest schema (§19.3), the capability-scoped API surface (§19.2), the MCP/plugin hub install surface (§19.5), and the adapter form-schema convention (§19.6). Enable the composition engine by default (remove the flag).
- **Exit**: Extensions can declare manifests, register panels, define capabilities, and add adapter kinds. The full extensions API (Tier C) is live.
- **Kill-switch**: Disable extensions via a server-side flag (`gw._extensionsEnabled = false`). The composition engine falls back to the built-in panels only.
- **What the user sees**: The Hub panel shows installable extensions. New panels appear in the tab bar when their extensions are installed. Adapter registration forms are dynamically generated.
- **Metrics**: extension install rate, capability-filter hit rate, adapter kind registration count.

**Old tab ID redirect map** (defined now, used in Phase 2):

| Old tab ID | → New domain |
|---|---|
| `console` | `now` |
| `rooms` | `now` |
| `history` | `output` |
| `artifacts` | `output` |
| `playground` | `output` |
| `goals` | `work` |
| `builder` | `work` |
| `hub` | `connect` |
| `voice` | `connect` |
| `integrations` | `connect` |
| `providers` | `brain` |
| `providers-live` | `brain` |
| `computer` | `control` |

### 20.4 Post-launch telemetry events to add

MUST. The following telemetry events must be added post-launch. The BACKEND GAP list is consolidated from each section's gap list, plus new events from this spec.

| Event | Description | Source § |
|---|---|---|
| `palette_open` | Palette opened (context: global/queue/palette) | §18.1 |
| `palette_command` | Command submitted (command name, args schema, latency) | §18.2 |
| `palette_search` | Search query executed (query length, result count, backend: substring|fts5) | §18.3 |
| `palette_object_resolve` | Object resolved via seq or token (resolution type, success) | §18.4–18.5 |
| `palette_nl_intent` | Natural-language fallback to planner (intent kind, proposal count, approval_needed?) | §18.6 |
| `panel_manifest_validate` | Manifest validation result (valid/invalid, error count) | §19.3 |
| `extension_install` | Extension installed (id, version, capabilities) | §19.5 |
| `extension_enable` | Extension enabled (id, version) | §19.5 |
| `extension_disable` | Extension disabled (id, version) | §19.5 |
| `extension_uninstall` | Extension uninstalled (id, version) | §19.5 |
| `capability_filter_hit` | Capability filter result (panel, domain, allowed/denied) | §19.2 |
| `adapter_kind_register` | New adapter kind registered (kind, form-schema field count) | §19.6 |
| `compose_engine_render` | Composition engine render time (panel, surfaces composed) | §5, §19.4 |
| `migration_phase` | Migration phase transition (phase, user-visible state) | §20.3 |
| `402_429_handled` | 402/429 response received and recovered (endpoint, retry count) | §20.1 I5 |
| `tg_api_raw_fetch_blocked` | Attempt to use raw fetch with operator token (blocked) | §19.2 BACKEND GAP |
| `tg_session_unavailable` | TG.session access attempt when capability-scoped session is unavailable | §19.2 BACKEND GAP |
| `search_backend_fts5_swap` | Search backend transition from substring to FTS5 | §18.3 SHOULD |

### 20.5 Roll-up gates (12 acceptance gates)

1. **G1 — Search works end-to-end**: `GET /v2/search?q=test` returns typed, sequenced results from the unified index (sessions/objects/artifacts/audit). Chain-seq jump works from palette to History panel. (Owns: §18.3, §18.4)

2. **G2 — All v1 commands map to real mounts**: Every slash command in the palette table resolves to a tested gateway endpoint. No invented commands. (Owns: §18.2)

3. **G3 — Fuzzy object-id resolution works**: A seq number and an 8-hex transparency token both resolve to the correct object in the palette. Anti-enumeration holds (unknown token shows same result as non-existent session). (Owns: §18.5)

4. **G4 — NL→intent never auto-executes**: Planner proposals with `needs_approval` create pending approvals; no action is taken without explicit `/approve` or `/deny`. (Owns: §18.6)

5. **G5 — Keyboard map is complete and conflict-free**: Global, queue, and palette keyboard contexts work without conflicts. ⌘K opens the palette from any context. Esc closes modals. Tab navigation cycles correctly. (Owns: §18.7)

6. **G6 — Capability-scoped API surface**: `TG.api` validates calls against the extension's declared `requiredCapabilities`. No extension can call `fetch()` directly with operator tokens. (Owns: §19.2)

7. **G7 — Panel manifest schema validated**: Every panel manifest passes schema validation before mount. The composition engine rejects invalid manifests. (Owns: §19.3)

8. **G8 — Plugin hub audit trail complete**: Every install/enable/disable/uninstall action is audited with the correct event type. The hub panel displays the audit trail. (Owns: §19.5)

9. **G9 — Adapter kinds are data-driven**: `GET /v2/adapters/kinds` returns all registered kinds with form schemas. Registering a new kind adds a registry entry + panel form schema. (Owns: §19.6)

10. **G10 — Tier A smoke matrix passes**: All 9 domains have automated smoke tests. The 611-test suite passes. (Owns: §20.2)

11. **G11 — Migration redirect map is live**: All 13 old tab IDs redirect to their new domain IDs. No broken-URL windows during migration. (Owns: §20.3)

12. **G12 — Tier C extensions API is operational**: Mount-declared executors, TG_PANELS registration, plugin hub install surface, and adapter form-schema convention are all live. The capability-scoped API surface is closed (BACKEND GAP resolved). (Owns: §19.1–19.6)

SHOULD. G13 — Telemetry events fire for every user action in the palette, panel, and extension surfaces. This gate is SHOULD because telemetry infrastructure does not exist yet (BACKEND GAP).

MAY. G14 — A/B testing framework for palette ranking, panel ordering, and migration phase promotion. This is a MAY because it is a future optimization that does not block the core rollout.

---

## §18–20 BackEND GAP summary

The following gaps must be closed before the corresponding requirements can be considered production-ready. Each gap is cited from its owning section.

1. **§19.2 — `TG.api` uses operator tokens, not capability-scoped access**: Extension panels currently CAN reach raw `fetch` with operator tokens. The capability-scoped API surface must be implemented and the raw-fetch path must be blocked.
2. **§19.2 — `TG.session` does not exist**: A capability-scoped session accessor is needed. Requires a new `GET /v2/sessions/:id` endpoint.
3. **§19.3 — Panel manifest validation harness does not exist**: `tests/panel-manifest.test.js` must be written. The schema validator must be built.
4. **§19.2 — `/model` command has no dedicated mount**: Model selection is via provider routes, not a `/model` command endpoint.
5. **§18.2 — `/interrupt` has no endpoint**: No interrupt/abort endpoint for running actions exists. Only provider timeouts use `abort()`. The `control.take` capability and its endpoint must be built.
6. **§18.3 — FTS5 is not yet live**: Search currently uses substring matching. The FTS5 virtual table exists in `sql-chain.js` but `searchChain` has not been swapped.
7. **§18.5 — Transparency token prefix lookup does not exist**: The anti-enumeration design prevents prefix search. A server-side partial-token index would be needed for the SHOULD-level fuzzy scan.
8. **§20.2 — Conformance tier smoke matrix is not built**: Automated smoke tests per domain must be written.
9. **§20.4 — Telemetry infrastructure does not exist**: All telemetry events in the post-launch table require the telemetry pipeline to be built.

---

*Spec written against `/root/agent-workforce/docs/ux/00-KERNEL.md` and `/root/agent-workforce/docs/v2/PLATFORM-ABI.md`. Code anchors verified against `src/gateway/`, `app/panels/`, `src/cli/`, `mounts/`, `tests/`. 611 tests green at time of writing.*