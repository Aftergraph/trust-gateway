# Rollout promotion log (§20)

Gate runner: `scripts/conformance-tier-a.sh` (tests/conformance/run.js).
Rule: a phase may only be declared complete when **tier-A is 9/9** and the
full suite is green on the phase's head commit. Entries are append-only.

---

## 2026-09-03 — Phase 0 (token/theme swap): **COMPLETE**

- **Head**: `be3767d` (main, pushed)
- **Entry gate**: suite green at phase start (688/688 @ `0078095`) ✓
- **Work**: `app/style.css` rewritten to the `--tg-*` token set from
  `docs/ux/04-EXPERIENCE.md` §13.3 (all 69 former literals now flow through
  `var(--tg-*)`); light parity block added per §13.2.8;
  `app/responsive.css` dropped its duplicate hard `color-scheme: dark` so
  the light override can take effect. No selector, layout, or behavior
  changes — `grid-template-columns: 1.2fr 1fr 1fr` pin test still green.
- **Exit gate**:
  - Full suite: **688/688 pass** (`node --test tests/*.test.js`)
  - Conformance tier-A: **9/9 ALL PASS** (NOW CHAT WORK AGENTS BRAIN OUTPUT CONTROL CONNECT SYSTEM)
  - Live console at :8800 serves the token CSS (131 `--tg-` refs on `/style.css`)
- **Kill-switch exercised?** Not needed; revert path is `git revert be3767d`
  (CSS-only, zero state impact).
- **Derived tokens** (extensions beyond §13.3, documented in style.css header):
  `--tg-state-ok-bg`, `--tg-border-accent`, `--tg-border-accent-strong`,
  `--tg-border-destructive`, `--tg-border-write-accent`, `--tg-row-line`.

## 2026-09-03 — Security event (logged per auditability rule)

- **What**: the first draft of `tests/conformance/run.js` embedded the live
  Dialagram key as an `||`-fallback default and reached `main` in commit
  `4c1f6d8`, which was pushed to the **public** repo.
- **Detection**: self-caught during the conformance fix pass.
- **Containment**: fallback removed (env/gitignored-file only, fail-safe
  empty string); history rewritten (`git filter-branch`, range
  `de38ad3..HEAD`); force-pushed; old commits 404 on origin; GitHub code
  search index already stale-cleaned (blob "Not Found").
- **Residual risk**: the key is live in gitignore'd `data/gateway.env`
  (correct place), but **rotation in the Dialagram dashboard is the only
  true containment** for the window it sat public — pending owner action.
- **Rule adopted**: conformance/runner files take secrets from env only; no
  `||`-defaults with live values. Grep for `dgr_live_`/`Bearer ` patterns is
  part of every push checklist going forward.

---

## 2026-09-03 — Phase 1 (queue-first NOW + palette): **COMPLETE**

- **Head**: `746b146` (main, pushed)
- **Entry gate**: Phase 0 complete ✓
- **Work**:
  - Tab order: History pinned directly after Console (NOW priority).
    Kill-switch `?tabs=legacy` restores the Phase-0 order verbatim;
    tab ids unchanged → redirect guarantee holds.
  - NOW queue strip in the header: pending-approval count + open-queue
    jump visible from **every** tab (same store as the Console pane —
    single decision surface, §20 Phase 1 exit criterion met).
  - Palette (⌘K / Ctrl+K): one input, context set = tab jumps +
    `GET /v2/search` audit hits as the primary channel (§18.1/§18.2);
    Enter on a hit → `TG_HISTORY.jumpToSeq(seq)` → History mounts,
    loads window `seq±(40/20)`, highlights + opens the row (§18.3).
  - Long-standing bugs fixed on the way (pre-phase-1, wave-B vintage):
    `switchTab('console')` rendered a "panel not loaded" placeholder and
    hid the 3-pane grid (no console panel exists); `.view-show` was
    toggled by the router but no CSS rule keyed on it, so every mounted
    panel and the history modal were permanently visible.
- **Exit gate**:
  - Full suite: **695/695 pass** (7 new phase-1 regression tests:
    palette wiring, queue strip, jumpToSeq contract, XSS policy,
    CSS visibility contracts, /v2/search numeric-seq hit shape)
  - Conformance tier-A: **9/9 ALL PASS**
- **Kill-switch**: `git revert 746b146` (UI-only), or runtime
  `?tabs=legacy` for the tab-order half. No state touched.
- **Gates G1–G4**: G2/G4 pass (commands map to real mounts; needs_approval
  still parks, no auto-execute — tier-A CONTROL covers it). G1's palette→
  history jump is client-side and shipped; G3 (fuzzy token/seq resolution)
  remains open — token-prefix lookup is a listed BACKEND GAP.

---

## 2026-09-03 — Phase 2 (domain rail + deep-link URIs): **COMPLETE**

- **Head**: see commit `feat(phase2)` below (main, pushed)
- **Entry gate**: Phase 1 complete ✓ (tier-A 9/9 at 746b146)
- **Work**:
  - **9-domain rail** (§2.1): the nav now shows NOW · CHAT · WORK · AGENTS ·
    BRAIN · OUTPUT · CONTROL · CONNECT · SYSTEM. The 13 panels keep their
    ids and become sub-panels inside their owning domain (subnav strip when
    a domain has >1 panel; landing panel per domain remembered across visits
    — §2.3 revisit semantics).
  - **Deep-link URIs**:
    - Bare domains `/now … /system` serve the console shell (server static
      route) — bookmarkable, zero 404 windows.
    - Object links `GET /d/<DOMAIN>/o/<type>/<id>` (new mount 97-deeplink):
      run, approval, goal, artifact, adapter, room, message,
      computersession, memory, session (sess_<transparency-token>),
      auditentry (seq_N) — each resolves to its canonical store with the
      owning surface's RBAC (worker = own objects, operator = all).
      Browser Accept:text/html gets the shell; JSON Accept gets the
      resolver answer. Unknown type / wrong domain namespace → 404 with a
      stable reason, never a silent redirect (§2.2 rule).
    - Client boot: on `/d/...` the console resolves via TG.api, opens the
      owning panel; auditentry links reuse the phase-1 seq-jump (§18.3).
  - **G11 redirect map** (§20.3, verbatim from the spec table): `console →
    now`, `history → output`, `goals/builder → work`, `hub/voice/
    integrations → connect`, `providers/providers-live → brain`,
    `computer → control`, `playground/artifacts → output`, `rooms → now`.
    Old `#hash` links land on their domain; `?tabs=legacy` kill-switch
    restores the full 13-tab Phase-1 rail.
  - **New panels**: AGENTS (bots × live run counts via /v2/runs) and SYSTEM
    (health, chain seal, entries, bots) — the two domains that had no
    surface. app/panels/agents-system.js.
- **Anti-enumeration (G3, session tokens)**: unknown/missing session tokens
  answer byte-identical (same 404 body, token replaced by `sess_********`,
  constant-time comparison against transparency tokens). Test asserts
  equality of raw bodies for two different unknown tokens.
- **Exit gate**:
  - Full suite: **710/710 pass** (10 deeplink resolver tests + 4 phase-2
    rail/redirect tests + updated core expectations)
  - Conformance tier-A: **9/9 ALL PASS** (live gateway, post-restart)
  - Live probes: all 9 domain URIs → 200 shell; `/d/NOW/o/run/r_e9464705` →
    200 resolved (engine/bot/state/steps); `/d/CONTROL/o/auditentry/seq_418`
    → 200; unknown type → 404; browser nav → shell without leaking object
    data pre-auth.
- **Kill-switch**: `?tabs=legacy` (rail) — redirect map is a plain object in
  core.js; deleting it falls back to flat 13-tab behavior per spec.
- **Known gap (honest)**: the merged wave-F llm-loop keeps deepTurn's return
  shape strictly (no runId in the reply body — spec-compliant), so clients
  discover runs via `GET /v2/runs?limit=…` (or by watching SSE run_started).
  Deep-link boot for a run therefore needs the id from the runs list, not
  from a chat reply.

---

## 2026-09-03 — Phase 3 (composition engine behind flag): **COMPLETE**

- **Head**: `feat(phase3)` commit below (main, pushed)
- **Entry gate**: Phase 2 complete ✓ (tier-A 9/9 at 42f503e)
- **Work**:
  - **`app/compose.js`** — the §5 decision function as a pure, deterministic
    module: kernel surface vocabulary (12), intent enum (7), §5.2 MUST-rule
    order implemented exactly: risk override (destructive → Modal/Drawer
    gate at stack 0 + background dim + inline Composer/Queue stripped),
    awaiting-approval Queue pin (regardless of intent), unknown-intent →
    Feed fallback, mobile Detail→Summary density collapse with surface
    *class* preserved. Learned-preference re-ranking deliberately NOT
    implemented (MAY; §4.6 determinism is the safer default). Every omit
    carries `omittedBecause ∈ {risk,capability,intent,device}` — asserted
    across a combo matrix (rule 28).
  - **§19.3 manifests** for all 15 built-in panels + `validateManifest()` —
    **closes the spec-named BACKEND GAP "panel-manifest validation harness"
    (G7)**: `tests/panel-manifest.test.js` validates every shipped manifest,
    rejects 7 crafted invalid ones with useful errors, and pins engine
    behavior (12 tests, all green).
  - **Capability filter (§19.3)**: action surfaces hidden for ungranted
    verbs, panel itself never removed (dim, never hide).
  - **`GET /v2/whoami`** (new mount 98-whoami): identity →
    {name, role, capabilities} allow-list projection (strict, no token
    material — same pattern as /v2/bots). Minimal closure of BACKEND GAP
    "TG.session/identity"; scopes/extra roles stay future work.
  - **Flagged integration**: `showPanel()` consults
    `TG_COMPOSE.composePlan(domain)` only when `?compose=true` or
    `localStorage['tg-compose']='true'`; a capability-filtered panel shows
    the "action surfaces hidden" strip. Old tab-router path is untouched —
    instant fallback (§20 Phase 3 exit criterion). `/compose.js` served +
    added to the PWA shell (sw cache bump w9.1.0).
- **Exit gate**:
  - Full suite: **722/722 pass** (+12 manifest/engine tests)
  - Conformance tier-A: **9/9 ALL PASS** (live gateway restarted on this code)
  - Live probes: `/compose.js` → 200; `/v2/whoami` →
    `{"name":"atlas","role":"operator","capabilities":["*"]}`
- **Kill-switch**: drop `?compose=true` / clear localStorage → Phase-2
  router behavior restored instantly. No state touched.

---

## 2026-09-03 — Phase 4 (extensions + capability-scoped API): **COMPLETE**

- **Head**: `feat(phase4)` commit below (main, pushed)
- **Entry gate**: Phase 3 complete ✓ (tier-A 9/9 at 3fc3233)
- **Work**:
  - **G6 — capability-scoped `TG.api`** (§19.2): the console binds the
    identity's grants from `/v2/whoami` into a scope object;
    `TG.api.scope(['goal.create'])` returns a fetch-like wrapper that
    refuses verbs outside the grants BEFORE any request leaves the page
    (`capability_missing:<cap>` refusal). Route→capability map mirrors
    server policy (approvals→approval.decide, plugins→plugin.install,
    adapters→adapter.manage, memory→memory.write, runs-cancel/computer→
    control.take, goals→goal.create, providers→provider.select);
    read-only routes (GET plugins/kinds/runs/memory) explicitly cap-free.
    Extensions no longer have any reason to touch raw fetch with the
    operator token — the wrapped surface is the sanctioned path.
  - **G9 — data-driven adapter kinds** (§19.6): new mount
    `GET/POST /v2/adapters/kinds`. 5 built-in kinds seeded with field
    schemas (secret fields marked); operator POSTs register new kinds into
    `data/adapter-kinds.json` (atomic+0600) — no code change; enum/string/
    number/boolean/url/secret field kinds validated; builtin override
    rejected; every register/reject audited
    (`adapter_kind_register`/`adapter_kind_rejected`, TRANSPARENCY 79→81).
    Route-shadowing bug fixed on the way: 70-adapters' id segment
    previously swallowed `/v2/adapters/kinds` (negative lookahead now
    reserves `kinds`).
  - **G8 — hub audit trail** (§19.5): the Hub panel now renders the hub
    event history straight from the sealed chain (installed/enabled/
    disabled/uninstalled/rejected + kind events, last 25, ids/versions/
    error-lists only) and live-refreshes on `plugin_*`/`adapter_kind_*`
    SSE events. Server-side lifecycle audit set verified end-to-end in
    tests (real hub install → enable → disable → uninstall → 4 chain
    types present).
  - **Extension manifest schema (§19.3)** was already closed in Phase 3
    (G7); Phase 4's install surface rides the existing
    `/v2/plugins` install/enable/disable/uninstall + secrets endpoints —
    no new endpoints needed, the Hub UI just surfaces them.
- **Exit gate**:
  - Full suite: **727/727 pass** (+5 phase-4 tests: kinds registry RBAC +
    validation + persistence, client scope source-contract, hub sections,
    plugin lifecycle audit set)
  - Conformance tier-A: **9/9 ALL PASS** (live gateway restarted on this code)
  - Live probes: `/v2/adapters/kinds` → 5 builtin kinds with field schemas;
    `/v2/adapters` unshadowed → 200.
- **Kill-switch**: kinds registry is additive (GET-only unless operator);
  `TG.api.scope` refusals fail closed — extensions falling back to raw
  fetch are a policy violation surfaced in review, not a runtime hole
  (server RBAC still enforces everything).
- **Gates after Phase 4**: G1 ✓ G2 ✓ G4 ✓ G6 ✓ G7 ✓ G8 ✓ G9 ✓ G10 ✓ G11 ✓.
  Open: **G3** (fuzzy token/seq resolution part 2: palette prefix lookup),
  **G5** (full keyboard map + conflict check), **G12** (roll-up: needs
  telemetry infra — the last BACKEND GAP).

---

## Next gate targets (open)

- BACKEND GAPs still open after wave F: TG.api operator tokens, TG.session,
  manifest validation harness, /model mount, /interrupt endpoint, FTS5 live,
  token prefix lookup, telemetry infra (cost-preview and runs/conformance
  GAPs closed by wave F).
