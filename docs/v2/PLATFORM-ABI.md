---
status: contract — locked for wave A (10 parallel agents)
date: 2026-09-02
audience: build agents + humans extending the platform
---

# Trust Gateway Platform — ABI & Ownership Contract (v2 wave A)

## Non-negotiable platform rules
1. **Zero npm dependencies.** Node 24 built-ins only (`node:http`, `node:sqlite`,
   `node:crypto`, `node:fs`, `node:events`, `node:child_process`, `node:readline`).
2. **Routes = mounts plugin files only.** Add `src/gateway/mounts/NN-name.js`
   exporting `{name, method, path(string|RegExp), auth:'bearer'|'query'|'none',
   handle:async(gw,req,res,ctx)}`. **NEVER edit `src/gateway/server.js`** —
   the mount runner calls you before v1 routes. ctx = `{url, params, bot}`.
   `send()` helper: `require('../server')`.
3. **Every stateful decision goes through `gw._audit(payload)`** — seals +
   persists + emits SSE automatically. Payloads must be JSON-round-trip safe
   (no undefined-valued keys — they are stripped and that changed hashes; the
   round-trip fix is in place, keep payloads plain).
4. **Storage:** chain = `gw.chain` (SqlChain when data/gateway.db exists, else
   HashChain). NEW persistent state → own JSON file under `data/` with atomic
   tmp+rename, mode 0600, refuse-to-load-on-corrupt (fail closed). Copy the
   pattern from `src/gateway/approvals.js`.
5. **Never leak:** bot tokens, secret values (args/argsSummary), other bots'
   jail contents. Bot-facing projections = {name, role, capabilities} only.
6. **RBAC:** approval/operator actions check `canApprove(bot)`
   (`src/gateway/rbac.js` exports it; role operator or cap `approval.decide`/`*`).
7. **XSS policy (app/ + site/):** no `innerHTML =` anywhere — textContent only.
   This is test-enforced.
8. **Tests:** `node --test tests/*.test.js`, ALL green (base: 137). Mock network
   with a local `http.createServer` stub; never hit real providers in tests.
9. **Commits:** work ONLY in your assigned worktree/branch; stage ONLY your own
   files (`git add <your files>` — never `-A` blindly). Identity
   `Jonas Abde <jonas@autonomousventure.company>`.
10. **Report:** files, test counts (base+new), commit SHA, deviations.

## Gateway surface available to mounts (read src/gateway/server.js to see all)
- `gw.bots` name→{token,role,capabilities}; `gw.chain` (append/verify/since/entries/head)
- `gw.approvals` (request/get/resolve/listPending); `gw.dispatch(bot,tool,args)` (may throw)
- `gw._audit(payload)` → sealed entry; `gw.on('audit', fn)` live stream
- `getHub(gw)` from `src/gateway/events.js` → `hub.broadcast(type, payload)` (SSE)
- `{classify, decide}` from policy; `canApprove` from rbac
- `ChatPlanner` from `src/gateway/chat.js` (sessions, plan())

## Wave A ownership matrix (file-level, disjoint)
| Agent | Branch | Owns (create/edit ONLY these) |
|---|---|---|
| W1 llm-brain | v2/llm | src/gateway/llm-brain.js, mounts/22-chat-llm.js, tests/llm-brain.test.js |
| W2 groups | v2/groups | src/gateway/groups.js, mounts/25-groups.js, tests/groups.test.js |
| W3 builder+profiles | v2/builder | src/gateway/agent-store.js, mounts/31-agents.js, tests/builder.test.js |
| W4 plugin/mcp/skills hub | v2/plugins | src/gateway/plugins.js, mounts/35-plugins.js, modules/**, tests/plugins.test.js |
| W5 artifacts+computer | v2/artifacts | src/gateway/artifacts.js, src/gateway/computer.js, mounts/40-artifacts.js, mounts/42-computer.js, tests/artifacts.test.js, tests/computer.test.js |
| W6 providers/models | v2/providers | src/gateway/providers.js, mounts/45-providers.js, tests/providers.test.js |
| W7 CLI/TUI | v2/cli | bin/tg.js, src/cli/**, tests/cli.test.js |
| W8 marketing site | v2/site | site/**, tests/site.test.js |
| W9 PWA+desktop shell | v2/pwa | app/sw.js, app/manifest.webmanifest, app/offline.html, app/icons/**, app/responsive.css, tests/pwa.test.js |
| W10 continuity+repair | v2/continuity | src/gateway/continuity.js, src/gateway/selfrepair.js, mounts/50-continuity.js, mounts/51-repair.js, tests/continuity.test.js, tests/selfrepair.test.js |

app/index.html + app/app.js + app/style.css are owned by the orchestrator —
agents that need console UI list the endpoints they expose; UI lands in wave B.

## Cross-cutting product vocabulary (use these names)
- **Module**: a plugin under modules/<id>/ with plugin.json manifest (W4).
- **Skill**: markdown/procedure doc with frontmatter, discoverable via W4 hub.
- **MCP**: modelcontextprotocol server registered in W4 hub (registry-level in
  wave A; live stdio client = wave B).
- **Computer session**: W5 abstraction — a bot gets {id, frames[], actions[]}
  streamed via SSE type `computer`; "live computer" tab in console (wave B).
- **Artifact**: W5 first-class: {id, kind(code|doc|image-ref|report), bot,
  sessionRef, content, version, createdAt}; SSE `artifact` events; follow-along
  stream endpoint GET /v2/artifacts/:id/stream.
- **Room**: W2 group chat: humans + multiple bots, message fan-out with
  round caps, every hop audited, A2A-compatible envelope
  {from, to:room, kind:'message'|'proposal'|'handoff', body}.
- **Brain**: W1 LLM adapter — OpenAI-compatible chat/completions via env
  TG_LLM_BASE_URL / TG_LLM_KEY (defaults to Dialagram). Brain output is
  UNTRUSTED text: it may PROPOSE actions only through ChatPlanner policy —
  never executed directly.

## Definition of done (every agent)
[ ] files as scoped, full suite green (base 137 + yours)
[ ] mount registered and smoke-tested over real HTTP in your tests
[ ] all decisions audited (chain verify ok in at least one test)
[ ] no server.js/other-agent edits, committed, SHA reported