---
status: current
date: 2026-09-02
audience: external coding agents (Claude, Codex, Jules, Hermes subagents) working on this repo
authority: derived from docs/v2/PLATFORM-ABI.md, docs/TRUST-GATEWAY-V1.md, docs/v2/PERSISTENCE-DASHBOARD-CHAT.md and the code as it exists — not aspirations
note: named CODING-AGENTS.md because the tooling blocks writes to any file named AGENTS.md
---

# CODING-AGENTS.md — conventions for coding agents on this repo

These are the real rules. They are enforced by tests and review. If you break
one, your PR fails — so read them once and don't fight the codebase.

## 1. Zero dependencies, always

Node 24 built-ins only: `node:http`, `node:sqlite`, `node:crypto`, `node:fs`,
`node:path`, `node:events`, `node:child_process`, `node:readline`.

- No `npm install`. No `package.json` deps. No polyfills, no vendored code.
- Need an HTTP client? `fetch` is global. Need JSON storage? `node:sqlite`
  (`DatabaseSync`) or the atomic-JSON pattern (rule 4).
- If you think you need a dependency, you need a smaller feature.

## 2. Routes = mount files. Never edit `server.js`

Add `src/gateway/mounts/NN-name.js` exporting one mount:

```js
module.exports = { name, method, path /* string|RegExp */, auth /* 'bearer'|'query'|'none' */, handle: async (gw, req, res, ctx) => {} };
```

- `ctx = { url, params, bot }` — the runner already authenticated per `auth`.
- One export per file. For multi-route surfaces use `method: '*'` + RegExp
  and dispatch inside `handle` (see `mounts/40-artifacts.js`).
- `src/gateway/server.js` is the orchestrator's file. Editing it in a wave
  branch is a merge conflict you created; don't.

## 3. Audit every stateful decision — write-ahead

Anything that changes state, denies a request, or hands work to a human goes
through `gw._audit(payload)` **before** execution:

- The seal is written before dispatch (`server.js` `_audit`), so refusals,
  approvals, and crashes are all on the record. Match that ordering.
- Payloads must be JSON-round-trip safe: no `undefined`-valued keys (they get
  stripped and that changes hashes downstream). Plain data only.
- Secrets never enter audit payloads — log `value.length`, never the value.
  This is test-asserted (`plugins.js` secret handling, `policy.js` class
  `secret`).
- At least one of your tests must call `chain.verify()` and assert `ok: true`.

## 4. Storage pattern (copy `approvals.js`)

One store per concern. Durable state lives in its own JSON file under `data/`:

- Atomic write: `tmp` file + `fs.renameSync`, mode `0600`.
- Fail closed on corrupt load: refuse to start, don't silently reset.
- Env override for the file path (`TG_<NAME>_FILE`) — tests rely on it.
- Never store bot tokens, secret values, or key material in any file the
  gateway writes.

## 5. Frontend: textContent only

In `app/` and `site/`: no `innerHTML =` anywhere — `textContent` only. This
is test-enforced (`tests/app.test.js`, `tests/site.test.js`). Escape
everything you interpolate; if you need HTML structure, build nodes.

## 6. Tests before commit

- Run `node --test tests/*.test.js` — **all green**, base was 137 tests at
  wave A and only grows. Your feature ships with its own test file.
- Mock network with a local `http.createServer` stub. Never hit real
  providers (Dialagram, OpenRouter, OpenAI…) from tests — not even "just once".
- Mount endpoints are smoke-tested over real HTTP in your tests
  (`http.createServer(gw.handle.bind(gw))` pattern).

## 7. Commit discipline

- Work only in your assigned worktree (`/tmp/wt-<task>.<name>` convention).
- Stage only your own files: `git add <files>` — never `git add -A`.
- Identity: `Jonas Abde <jonas@autonomousventure.company>`.
- Report: files touched, test count (base + new), commit SHA, deviations.
- No questions mid-wave; the ABI contract (`docs/v2/PLATFORM-ABI.md`) is the
  answer key. If reality and contract disagree, report the drift.

## 8. Never leak

Bot-facing projections are `{name, role, capabilities}` — nothing else.
Bot tokens live only in `gw.bots` and `BOT_TOKENS` env. Secret values and
other bots' jail contents (`data/bots/<name>/`) never appear in API
responses, audit payloads, SSE broadcasts, or logs.

## 9. Where the truth lives

| Question | Source |
|---|---|
| Platform rules, ownership matrix | `docs/v2/PLATFORM-ABI.md` |
| Governance guarantees (this product) | `docs/standards/AI-GOVERNANCE.md` |
| What each module does + full event map | `docs/standards/TRANSPARENCY.md` |
| v2 slice decisions (storage, SSE, chat) | `docs/v2/PERSISTENCE-DASHBOARD-CHAT.md` |
| v1 design rationale | `docs/TRUST-GATEWAY-V1.md` |

`tests/standards.test.js` asserts that `TRANSPARENCY.md` stays in sync with
the actual audit-event strings in `src/gateway/**` — if you add an event
type, update the table in the same commit.