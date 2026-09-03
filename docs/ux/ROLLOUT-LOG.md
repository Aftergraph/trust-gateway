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

## Next gate targets (open)

- **Phase 1 (NOW-first tabs)**: entry = Phase 0 complete ✓. Requires tab
  reorder + approval-queue surfacing in the Console panel + palette search
  promotion. Gate: tier-A 9/9 + G1–G4 (see 05-SYSTEM.md §20 gates).
- BACKEND GAPs still open after wave F: TG.api operator tokens, TG.session,
  manifest validation harness, /model mount, /interrupt endpoint, FTS5 live,
  token prefix lookup, telemetry infra (cost-preview and runs/conformance
  GAPs closed by wave F).
