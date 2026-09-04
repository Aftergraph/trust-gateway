---
status: current
date: 2026-09-02
audience: operators, auditors, customers evaluating this product
related: docs/TRUST-GATEWAY-V1.md, docs/COMPARISON-2026-09-02.md, docs/standards/TRANSPARENCY.md
---

# AI-GOVERNANCE.md — the standards this product holds itself to

These are the guarantees the Trust Gateway makes and how each one is
implemented in code you can read. Every claim here maps to a module and a
test. Nothing on this page is aspirational; where a limitation exists, it is
stated.

## 1. Fail-closed policy

**Standard:** an action the system cannot classify is refused, not guessed.

- `src/gateway/policy.js` classifies every tool call into
  `read | write | destructive | secret`. Unknown tool ⇒ `destructive`.
- `destructive` **always** requires human approval — even with capability.
  `write` requires capability, else approval. `secret` denies outright
  unless an approved request plus capability exists.
- Approvals expire fail-closed: TTL 900s default; an expired request resolves
  as denied, never auto-allowed (`src/gateway/approvals.js`).
- Every decision is sealed write-ahead (`server.js` `_audit` before
  dispatch), so refusals and crashes are as much on the record as successes.

**Operational check:** `GET /v1/audit/verify` → `{ok:true,…}`; send an
unauthenticated request and see `401` plus an `auth_rejected` audit entry.

## 2. Tamper-evident audit chain

**Standard:** nobody can rewrite history without detection.

- `src/gateway/hash-chain.js`: each entry is
  `{seq, prevHash, ts, payload, hash}` with
  `hash = sha256(seq | prevHash | ts | canonicalJSON(payload))`. Genesis
  `prevHash` is 64 zeros; genesis carries a per-instance `chainId` so
  entries cannot be replayed across gateway instances.
- `verify()` re-hashes the whole chain. One flipped byte invalidates every
  hash from that point — the failure names `at` (seq) and `reason`
  (`hash_mismatch`, `prev_hash_mismatch`, `seq_gap`).
- v2 storage: `src/gateway/sql-chain.js` keeps the identical chain semantics
  in `node:sqlite` (`data/gateway.db`); `bin/migrate-v2.js` refuses the
  migration unless the imported chain verifies **and** its head hash equals
  the JSONL head. Load path also refuses on an invalid chain
  (`HashChain.fromEntries` throws).
- Self-repair never rewrites hashes. `src/gateway/selfrepair.js` +
  `mounts/51-repair.js` diagnose and quarantine to
  `data/quarantine-<ts>.json` (atomic, 0600) and answer `503` on tamper.
  Recovery is a human decision, on the record.

**Operational check:** `GET /healthz` returns live `chain.verify()`; the
dashboard footer links `/v1/audit/verify`.

## 3. Human-in-the-loop approvals

**Standard:** a bot cannot execute what a human has not allowed.

- `needs_approval` creates a request with TTL in `src/gateway/approvals.js`.
- Approve/deny goes through `POST /v1/approvals/:id/approve|deny` and is
  RBAC-gated (`src/gateway/rbac.js` `canApprove`: role `operator` or cap
  `approval.decide`/`*`). A bot trying to self-approve gets
  `approval_forbidden` on the audit chain — the attempt is recorded.
- Every resolution (approve, deny, expire) writes `approval_resolved` with
  the approver id.

**Operational check:** `GET /v1/approvals` lists pending with TTLs; each
resolution is visible as an audit entry.

## 4. Jail isolation

**Standard:** a bot's file tools cannot see another bot's files or the host.

- `src/gateway/dispatcher.js` roots every bot at its own jail
  (`data/bots/<name>/` when dispatch enabled). Paths are canonicalized
  (realpath) before use; traversal and symlink escapes outside the jail
  refuse — including the destination-exists and destination-new cases.
- Dispatchers return result objects; errors surface as `{ok:false,error}`
  instead of throwing into the audit trail.
- Computer sessions (`src/gateway/computer.js`, `mounts/42-computer.js`)
  are owner-scoped: frames from anyone but the owner are refused and
  audited (`computer_frame_denied`); takeover/release is operator-only and
  audited (`control_taken`/`control_released`).
- Honest limit: bots currently share the host VDS. v1/v2 prove the gateway
  layer; per-bot container isolation (gVisor) is a stated non-goal for a
  later slice (`docs/TRUST-GATEWAY-V1.md`, `docs/v2/PERSISTENCE-DASHBOARD-CHAT.md`).

## 5. Secret hygiene

**Standard:** a secret's value exists in exactly one place and is never
echoed anywhere.

- Write-only secret storage in `src/gateway/plugins.js`: secrets are set,
  never read back; every audit record logs only `value.length`
  (`secret_configured {length}`, `secret_removed`). Same pattern for class
  `secret` in `policy.js` (OpenBot pattern).
- `TG_LLM_KEY` (llm-brain) is never logged, audited, or echoed.
- Provider registry (`src/gateway/providers.js`) stores names, base URLs
  and model ids only; keys live in the operator's env/credential store.
  The HTTP projection is an explicit allow-list so a future field cannot
  leak by accident.
- Bot tokens live only in `BOT_TOKENS` env / `gw.bots`; token comparison is
  constant-time (`cryptoSafeEqual`). `/v2/bots` projects
  `{name, role, capabilities}` — no tokens ever.
- Files the gateway writes are mode `0600`; `data/` is gitignored.

## 6. Model/provider honesty — including the free-tier reality

**Standard:** the system never pretends a model is available when it isn't,
and never hides which brain produced output.

- `src/gateway/providers.js` mirrors the operator's real provider pool with
  named lanes, including constraint notes: OpenRouter paid lanes exhausted
  (no credits), OpenCode Go rate-limited (monthly limit, resets ~19d).
- Free-tier-first routing (`plan({task, preferFree})`, pure heuristic, no
  network): ollama-cloud `glm-5.3-flash` → OpenRouter `minimax-m3:free` →
  OpenCode Zen `laguna-s-2.1-free`; non-free lanes rank last. LLM output is
  UNTRUSTED text: it may propose actions only through the policy
  (`ChatPlanner`/`classify`/`decide`) — never executed directly
  (`mounts/22-chat-llm.js`).
- When no LLM is configured, `/v2/chat/llm` degrades cleanly
  (`{fallback:true, reply}`) — no 5xx, no pretending.
- The deterministic v2 chat (`src/gateway/chat.js`) is intentionally
  model-free; proposals still traverse policy → approval → seal. Probe
  endpoints (`/v2/providers/probe`) are explicit, non-blocking, opt-in —
  availability claims come from actual probes, not cached optimism.

## 7. What SEALED and TAMPERED mean operationally

**SEALED** — an entry in the chain whose `hash` matches the recomputation
over `{seq, prevHash, ts, payload}` and whose `prevHash` matches the
previous entry's hash. Operationally:

- `GET /v1/audit/verify` → `{ok: true, length, head, chainId}`.
- Every entry you read was hashed at write time, before dispatch. Sealing
  is not a background job — it is the write path.
- On the SSE feed (`/v2/events?token=…`), every `event: audit` frame is a
  newly sealed entry.

**TAMPERED** — `verify()` returns `{ok: false, at, reason}`. Operationally:

- `/healthz` reports `chain: false`; the dashboard shows the broken state.
- `GET /v2/repair/diagnose` (operator) returns `503` with
  `{ok:false, repaired:false, quarantine:"quarantine-<ts>.json"}` — the
  suspect tail is snapshotted to `data/quarantine-<ts>.json` and audited as
  `selfrepair_diagnosed`. The chain is **not** rewritten; history stays
  broken and visible until a human decides.
- The gateway does not silently roll back to a "last known good" chain:
  a corrupted file refuses to load (`fromEntries` throws; migrate refuses).

## 8. Transparency itself is a standard

Every module, endpoint, audit-event type and storage file is documented in
[`TRANSPARENCY.md`](./TRANSPARENCY.md), and
`tests/standards.test.js` fails the suite if the docs drift from the code.
If a doc and the code disagree, that is a bug in one of them — fix it in the
same commit.

## 9. Known limitations (audited 2026-09-03)

Audited against `main @ 8b03b54` (916/916 tests green). Stated plainly, with
the dispatched/planned work that resolves each:

- **The jail is process discipline, not an OS sandbox.** `dispatcher.js`
  canonicalizes paths and refuses traversal/symlink escapes, and each bot is
  rooted at its own directory — but bots still share the host OS (the honest
  limit in §4, and the FS-C2 harness2 header says the same). OS-level
  sandboxing (namespaces/bubblewrap, gVisor) is roadmap v3 R4, UDSET.
- **Rate limits are in-process (in-memory).** FS-A2's per-user limits reset
  on gateway restart, so enforcement is per process, not durable. A
  persistent rate store arrives with the external API-key work (FS-E3,
  roadmap §v2i-3 — dispatched; `apikeys` rate table), which also closes
  roadmap gap item 2.
- **Backups are manual.** FS-B1's verified backup/restore (sha256 manifest +
  chain-head binding, `tests/backup.test.js`) exists, but nothing on main
  schedules `createBackup()` — the systemd backup timer + restore drill land
  with FS-E2 (roadmap §v2i-2 — dispatched).
- **Single-tenant.** One gateway process, one data-dir, one bot roster. The
  multi-tenant foundation (tenant store, namespaced chains/stores) is FS-E1
  (roadmap §v2i-1 — planned).