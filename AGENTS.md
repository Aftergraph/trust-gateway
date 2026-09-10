# trust-gateway — Agent Execution Contract

<!-- Generated 2026-09-10 from REPOSITORY_INVENTORY.json, CI_COMMAND_INVENTORY.json, CI_RESULTS.json and a
     live probe of branch main at HEAD 5ec9dc45b123be712eea78580c3de008bf7e3745. Revision 1.
     NOTE: the workspace inventory recorded main at 736e96b; this file was generated
     from the live checkout (main at 5ec9dc45b123be712eea78580c3de008bf7e3745). Re-verify against your SHA.
     Regenerate the command blocks; hand-edit only the Ratchet section. -->

## Project

  Name        trust-gateway
  Role        Trust boundary — policy, approvals, audit
  Purpose     Fail-closed runtime control and enforcement plane for governed autonomous agents, approvals, policy, budgets and tamper-evident audit.
  Languages   JavaScript/TypeScript (Node), Python (tests present)

## Local conventions (verified present on disk)

  BUILD:     — not detected in this repository
  TEST:      npm run test
  LINT:      — not detected in this repository
  TYPECHECK: — not detected in this repository
  VERIFY:    python3 scripts/verify_brand_assets.py

  Python note: interpreter and pytest availability are environment-dependent. `pytest` is not
  importable from `/usr/bin/python3` in this workspace as of 2026-09-10; run under the
  repository's own Python environment. Record the exact interpreter prefix here once known
  (for example `aie` requires `PYTHONPATH=src python3 -m pytest -q`).

  Probes
  - pytest files: ./scripts/test_verify_brand_assets.py
  - verifier scripts: scripts/verify_brand_assets.py

Precedence: this file beats the conversation; `/root/workspace/aftergraph/AGENTS.md` beats this file;
verified external state beats both.

## Executed verification (authoritative)

These commands were executed against the exact SHA shown and their result recorded in
`CI_RESULTS.json` (workspace scope). Treat a result from a different SHA as stale.

  npm test  passed  736e96ba  1,861 passed, 0 failed, 1 skipped; skipped W0.3 live check requires external Go toolchain/WORKS; zero-dependency Node runtime

  Re-run the row for your SHA before opening a PR. A green run at another SHA proves nothing
  about this one.

## Rules (inherited from the Aftergraph workspace contract)

  - Never commit secrets, tokens, or credentials. Never copy runtime secrets into fixtures, docs, or frontend code.
  - Conventional commits: `feat|fix|docs|refactor|test|chore(scope): description`. Sign off with a verified identity.
  - Run the repository's verification row for your SHA before opening a PR.
  - Evidence-bound: gate results tied to the exact SHA. Evidence from an older SHA is stale, not evidence.
  - Keep PRs narrow and reviewable. Preserve unrelated work. Update an existing PR rather than duplicating it.
  - Check `after-graph-governance/docs/contracts/` for relevant schemas before changing an interface.
  - Verify trust-gateway policy before touching approvals, auth, or budgets.
  - Prefer the smallest reuse-first change. Keep provider boundaries explicit and fail closed.
  - Risk surfaces (authority, permissions, audit, budgets, identity, secrets) require independent verification,
    not self-verification by the implementing agent.
  - Local green output does not prove production readiness. Do not claim completion from it.

## Ratchet — rules learned from observed failures

Every line below must trace to one observed agent failure in THIS repository.
Add a dated line when an agent fails in a new way; fix the strongest layer that prevents recurrence.

  (none recorded yet — this guide has not yet accumulated failure-derived rules)

Choose the strongest applicable layer:
  memory note  <  prompt instruction  <  guide rule  <  sensor (test/lint/schema)  <  environment constraint (permission, CI gate)

If a rule can be checked without human judgement, it does not belong in this list — it belongs in a sensor.

## Guide hygiene

  - Review monthly. Remove rules now enforced by automation. Consolidate rules addressing the same failure class.
  - When the same review comment appears three times, promote it to a gate that blocks the output.
  - Date every entry so stale guidance is identifiable.
  - A rule nobody can verify without subjective judgement is not a rule; rewrite or delete it.
