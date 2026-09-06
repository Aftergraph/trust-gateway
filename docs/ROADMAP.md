# Trust Gateway — Roadmap (2026-09-04 re-basis)

> **RE-BASIS 2026-09-04 (P0 Trust-Spine + P1 complete):** Denne sektion er den
> aktuelle sandhed; v3-sektionerne nedenfor er historiske wave-log.
>
> **Basis:** `main @ 2cd28c7→34177e9` (Tier C grøn: 9 shards, ~80s).
>
> **P0 Trust-Spine — COMPLETE (W0.1–W0.6):**
> - W0.1 Durable conversations (SQLite, replay, tenant-scoped) — `584a0cd`
> - W0.2 MissionProposal objekt + lifecycle — `19580b1`
> - W0.3 mission_id-korrelation: TG-side (synthetic + WORKS live via works-client)
>   + WORKS-side verificeret LIVE (Work QUEUED→SUCCEEDED med correlation_id) —
>   `8200cd0`, works-execution `ff8fb72`
> - W0.4 AIE persistent lease-state (SQLite + HMAC-tamper-evidence, overlever
>   restart) — aie `58fd5e1`, 207/207
> - W0.5 NeedsYouItem v1 (4 typer + NOW-projektion) — `6befea3`
> - W0.6 Alpha E2E mod real booted gateway — 8/8 inkl. conversation + NeedsYou
>   flows (tenant-fix `2cd28c7`) — `8ac9d95`
>
> **HC hard-cases runtime-implementeret:** HC4 (BudgetLedger reserve/settle/
> commit/refund med idempotens i AIE + TG), HC7 (WORKS VerifyBundle),
> HC8 (takeover mount + WORKS TakeoverHandler; revalidate-hook FØR
> permissions-check så fail-closed altid ekserceres), HC1/HC6 (demo v2 S2/S3).
>
> **P1 — COMPLETE:**
> - Project primitive v1 + /v2/projects (overview, needs_you, blockers, health)
> - Approvals-v2: batch + metrics
> - Takeover/hand-back med ownership-audit (idempotent, envelope-restore)
> - Context Inspector v1: /v2/context/:bot (6 lag med provenance + snapshot-hash)
> - Memory usage-trace + knows-about (reading=using, decay-aware)
> - Model Router v0.2: telemetry-driven fallback-learning (RouterTelemetry)
> - Universal composer v1: meta (attachments + mentions) i tamper-evident
>   payload hash + /preview
> - Computer takeover-flow UI: kontrol-bar (takeover/release/stop) +
>   checkpoint-annotations
> - A11y smoke: aria-labels, textContent-only pin, prefers-reduced-motion
> - ADR/doc-gæld repareret: README 175 test-filer (faktisk count),
>   reconciliation-matrix Budget-row korrigeret til verified reality
>
> **Fund & fixet undervejs (root-cause, ikke symptomer):**
> - db.js lazy singleton (import-tids open krasjede på locked WAL)
> - per-shard/per-file TG_DB_FILE isolation (SQLite cross-process contention)
> - sessions/users tmp-filer med eksplicit 0600 (0666-vindue under umask=0)
> - worktree snapshot id ms-kollision → random suffix
> - TG_AIE_FAIL_OPEN i 24 testfiler (revalidation fail-closed var korrekt,
>   testene manglede escape-hatchen)
> - BudgetLedger reservation-semantik korrekt implementeret i AIE + TG
>
> **Næste (P2 / eksterne aktører):** Track A live GO (real API-kreditter —
> owner-godkendelse), STUDY-013 G-13a implementer-rekruttering, STUDY-006
> deltagere, WORKS mission-contract SUCCEEDED-kæde med worker-scope.

---

# Trust Gateway — Roadmap v3 (2026-09-03)

Status basis: `main @ 8b03b54` — 916/916 tests grønne, tier-A 9/9 domæner,
gateway live på :8800 (chain 513+). Wave v2h (15 slices) konvergeret: G3/G5/
G12/FE1/FE2, FS-A1–A5, FS-B1–B3, FS-C1–C2, FS-D1 (integration battery +
load smoke + security sweep). Denne roadmap erstatter den spøjse
"next-wave"-plan fra wave-v2h-dispatchen og bygger på PM-auditens
konklusioner.

---

## 1. Current state (hvad der faktisk er skibet)

- **Kerne**: fail-closed policy + write-ahead hash-chain audit (SQLite via
  SqlChain), mounts-only HTTP-flade, jailed per-bot dispatcher.
- **Konsol** (phase 2–4): 9-domain rail, deep-links `/d/`, composition
  engine bag `?compose`, capability-scoped TG.api, adapter kinds.
- **Users wave (FS-A)**: scrypt-brugerkonti + sessions (FS-A1),
  user-bound chat + rate-limits (FS-A2), login/signup UI (FS-A3),
  SQLite unifiering fase 1–2 — providers, kv_store, users, sessions,
  approvals er alle env-gated på db.js (FS-A4/A5).
- **Ops wave (FS-B)**: verificeret backup/restore med sha256-manifest +
  chain-head-binding (FS-B1), systemd-unit + installer + status (FS-B2),
  site fase 2 — status/pricing/docs + chain-stamp (FS-B3).
- **Agent-dev wave (FS-C)**: skills som governed objects med approval-gated
  run (FS-C1), harness2 projektmodel med jailed build/run (FS-C2).
- **Konvergens (FS-D)**: real-gateway integration battery, load smoke
  (p95 < 500ms), security sweep (auth/traversal/secret-hygiene),
  worktree-portable tier-A runner (FS-D1/D2).

## 2. Gap-analyse (dokumenterede claims vs. implementering)

Ærlige huller, sortereret efter kommerciel vægt:

1. **"Hosted, tenant-isolated" (site/pricing)** — kodebasen er
   single-tenant. Én gateway, én data-dir, ét bot-roster. Største claim-gab.
2. **Ingen persistente rate-limits** — FS-A2's per-user grænser er
   in-memory; en genstart nulstiller dem. Docs antyder håndhævelse "per IP";
   det er kun pr. proces. *Status (2026-09-03): FS-E3 dispatchet —
   persistente rate-limits via apikeys rate-table.*
3. **Backup er manuel** — FS-B1 er verificeret, men der findes ingen
   skemalagt backup, ingen restore-øvelse i ops-dokumentation.
   *Status (2026-09-03): FS-E2 dispatchet — backup-timer + restore-drill.*
4. **systemd-unit ikke installeret** — FS-B2 leverede filerne; den kørende
   gateway er en nohup-proces. Ops-claimet ("we run it") hviler stadig på
   manuel drift.
5. **Jail er proces-disciplin, ikke OS-sandbox** — ærligt dokumenteret i
   FS-C2, men pricing-siden siger "isolated computer per bot" uden
   nuancen.
6. **Ingen ekstern API-nøgle-flade** — alt forbrug er enten browser-cookie
   eller bot-bearer. "OpenAI-compatible + A2A"-rækken i sammenligningen
   dækker kun det interne OpenAI-kompatible mount.
7. **Skills/harness2 er operator-only** — ingen self-service for en
   "workforce"-kunde; alt går gennem operator-RBAC.
   *Status (2026-09-03): E1 planned — multi-tenant foundation er
   forudsætningen (roadmap §v2i-1).*

## 3. Roadmap v3 — kandidat-faser

Vurderet mod: kommerciel værdi × teknisk risiko × slice-størrelse.

| Fase | Tema | Værdi | Risiko | Vurdering |
|---|---|---|---|---|
| R1 | **Multi-tenant foundation** | Høj | Middel | ACCEPTÉR — største claim-gab, blokerer "hosted"-fortællingen |
| R2 | **Ops-automatisering** | Høj | Lav | ACCEPTÉR — billigst, fjerner manuel drift |
| R3 | **Ekstern API-nøgler** | Middel-høj | Middel | ACCEPTÉR — åbner integration-kundesegmentet |
| R4 | **Sandbox-hærdelse (C3)** | Middel | Høj | UDSET — kræver OS-arbejde (namespaces/bubblewrap); dokumentér nuancen først |
| R5 | **Persistente rate-limits** | Middel | Lav | ACCEPTÉR som del af R1 (samme store: persistence) |
| R6 | **Skills self-service** | Middel | Middel | UDSET — afhænger af R1/R3 (hvem må dele hvad). FS-F4 marketplace: sharing er per-GATEWAY (global store); cross-TENANT deling er UDEN FOR scope i FS-F4 |
| R7 | **Backup-automatik** | Middel | Lav | ACCEPTÉR som del af R2 |
| R8 | **Conformance tier-B** | Lav-middel | Lav | LØBENDE — udvid tier-A med hver ny fase |

## 4. Anbefalet next wave (v2i) — 4 slices, klar til dispatch

### v2i-1: Multi-tenant foundation (FS-E1) — * største gab *
- **Mål**: flere isolerede tenanter på én gateway-proces; hver tenant har
  eget bot-roster, egen data-dir (`data/tenants/<id>/`), eget audit-chain
  scope og egen provider-konfig.
- **Slices**:
  1. `tenant.js` — TenantStore (SQLite på db.js, env-gated `TG_TENANTS_DB`),
     tenant-resolver-middleware i http-mounts (subdomæne → `X-Tenant`
     header → bearer-prefix), 404-antiedeling mellem tenanter.
  2. Chain/store-namespacing: audit + approvals + memory + artifacts får
     tenant-scope; sikkerhedssweep udvides med cross-tenant-lækagetests.
  3. Konsol/site: tenant-udvælgelse ved login, per-tenant statusside.
- **Gate**: 40+ nye tests; security-sweep skal bevise tenant-isolation;
  docs (AI-GOVERNANCE §multi-tenant) opdateret i samme commit.

### v2i-2: Ops-automatisering (FS-E2)
- **Mål**: gatewayen overlever en VDS-genstart uden mennesker.
- **Slices**:
  1. Installer + aktivér systemd-unit (FS-B2's filer), `deploy/install.sh`
     idempotent, health-check + auto-restart-verificering.
  2. Backup-cron: skemalagt `createBackup()` (systemd timer), restore-
     drill-script med bevidst korrupt backup → forventet fail-closed.
  3. Watchdog: chain-verificering + disk-audit i status.sh; alarm webhook.
- **Gate**: VDS-genstartstest: gateway oppe < 30 s efter boot, backup
  oprettet af timeren, restore-drill dokumenteret i ops/runbook.

### v2i-3: Ekstern API-nøgler (FS-E3)
- **Mål**: eksterne forbrugere (scripts, integrationer) kalder gatewayen
  med egne nøgler — adskilt fra bot-tokens og browser-cookies.
- **Slices**:
  1. `apikeys.js` — nøgle-store (SQLite, env-gated), `tgk_`-prefiks,
     sha256-lagring (samme mønster som sessions), scopes + rate-limits,
     operator-only CRUD-mount.
  2. Auth-middleware: bearer-nøgler accepteret på udvalgte read-mounts
     (audit, search, providers, memory read); alt skrivearbejde kræver
     stadig bot-token + approval-flow.
  3. Docs + eksempler: `docs/api.md` med curl-eksempler pr. scope.
- **Gate**: sweep-test (nøgle kan ikke læse tværs af scopes, kan ikke
  skrive), rate-limit-persistens (genstart bevarer tællere — løser også
  R5), nøglerotationstest.

### v2i-4: Transparens-ærlighed (FS-E4) — * lille, høj signal *
- **Mål**: docs matcher virkeligheden; ingen overclaim i pricing/site.
- **Slices**:
  1. site/pricing + COMPARISON opdateres: "hosted" → "hosted (single-
     tenant i dag, multi-tenant på vej)", "isolated computer" → "jailed
     process island (OS-sandbox on roadmap)".
  2. AI-GOVERNANCE får et "known limitations"-afsnit (jail-risiko,
     in-memory rate-limits indtil v2i-3, backup-manuel indtil v2i-2).
- **Gate**: standards.test.js-docs-konsistens + manuel gennemgang.

## 5. Ikke-glem-liste (fra PM-auditen)

- **Process**: subagenter dør på 429/output-schema — dispatch med
  realistisk `output_schema` (kun commit_sha + testtal), pin model med
  fallback, kap batch-størrelse til 4–6, aldrig 15.
- **Arbejdstræe-GC**: `/tmp/wt-*` vokser utæmmet — ryd op efter merge
  (`git worktree remove`), behold kun active wave.
- **TRANSPARENCY-kollisioner**: række-intervaller fordeles pr. slice ved
  dispatch (ikke emergent ved merge) — kollisionen var den ene tilbagevendende
  konfliktklasse i hele v2h.

---

---

## 6. Wave-log (faktisk leveret)

- **v2h** (15 dispatchet, 12 landet, FS-B1 + FS-D1 overtaget af parent):
  G3/G5/G12/FE1/FE2 + FS-A1–A4 + FS-B1–B3 + FS-C1–C2.
- **v2i**: FS-A5 (users/sessions/approvals → SQLite), FS-B1 (backup,
  parent-inline), FS-D1/D2 (integration battery + load smoke + security
  sweep + tier-A portabilitet), FS-E1 s1 (tenant foundation), FS-E2 (ops
  automation), FS-E3 (tgk_ API-nøgler + persistente rate-limits), FS-E4
  (honesty pass).
- **v2j**: FS-E1 s2 (tenant-scoped memory/artifacts/search), FS-E1 s3
  (tenant CRUD + whoami + konsol-chip), FS-E1 s4 (tenant-scoped approvals
  + audit/events), FS-F1 (skills self-service `skills.own`), FS-F2
  (conformance tier-B + policy null-tool crash-fix).
- **Ops**: systemd-unit installeret på VDS (tg-gateway active+enabled),
  tg-backup.timer 04:00 live, restore-drill verificeret fail-closed.

## 7. Næste bølge (v2k/v2l) — status

- **FS-F3**: sandbox hardening spike — LEVERET (e244a36): bwrap + unshare
  (user-ns) + systemd-run alle tilgængelige på host'en (målt); `TG_SANDBOX=1`
  aktiverer wrapping (privat /tmp-tmpfs, ro-bind af jail + node, `--unshare-net`
  medmindre network:true) med ærlig fallback; **bwrap-krav: /usr/lib64 som
  mount-point** (loader-symlink dingler ellers). Byte-identisk uden env.
- **FS-F4**: skills marketplace — LEVERET (0e379d2): `visibility`
  private/shared, publish/unpublish (operator-only, auditeret), shared-katalog
  uden steps, non-owner dry-runs; real runs forbliver approval-gated;
  unpublish gendanner 404-anti-enum. Per-GATEWAY scope; cross-TENANT deling
  er stadig fremtidigt arbejde.
- **FS-F5**: tier-C chaos + RUNBOOK — LEVERET (4805e42): 4/4 scenarier
  grønne (kill -9 ×3, concurrent WAL-writers, ENOSPC fail-closed, restart
  storm ×5); **to ægte sql-chain-bugs fundet og fixet** (busy_timeout 5000
  mod cross-process SQLITE_BUSY; genesis INSERT OR IGNORE mod boot-race);
  `docs/RUNBOOK.md` dækker alle fire failure-modes med målt adfærd.
- **Ops**: systemd-unit installeret på VDS via deploy/install.sh
  (2026-09-03).

## 8. Næste kandidater (v2m) — ALLE LEVERET (verificeret 2026-09-05)

- (a) Skills shared på tværs af tenants: LANDET som FS-I1 (79adeff) — cross-
  tenant REAL runs med dual-approval (begge tenanter godkender, chain-stemplet
  begge steder). Verificeret 2026-09-05 på main @62f455f: skills-fed-real.test.js
  8/8 grøn (dual approval, side-scoping, 404-gating, re-execute block),
  skills-fed-ledger + skills-federation 16/16 grøn.
- (b) Observability-dashboard: LANDET som FS-I2 (d52403f) + FS-I3 quota —
  AlertSink-telemetry + chain-længde + rate-tællere.
- (c) Multi-signal alarmering: LANDET som FS-I2/I4 — watchdog → webhook.
- (d) Self-host dokumentation: LANDET — Dockerfile (95b5f8d) + deploy/
  restore-drill.sh + RUNBOOK som kundevendt docs.

## 9. Wave v2p leveret

Batch konvergeret på `main @ b72562f` — 1137/1137 tests grønne.
TRANSPARENCY rækker 118–139 tilføjet. Syv slices landet:

- **FS-I1** (79adeff): cross-tenant REAL runs med dual-approval —
  begge tenanter skal godkende, chain-stemplet begge steder.
- **FS-I2** (d52403f): observability koblet på AlertSink —
  telemetry-events udløser operator-alarmer.
- **FS-I3** (3b1d6ad): tenant-quota enforcement på disk + API —
  fail-closed ved overskridelse.
- **FS-I4** (885271c): audit-log export via webhook + S3-stub.
- **FS-I5** (5d2c81b): secrets vault med AES-256-GCM
  per-tenant kryptering.
- **FS-I6** (6942575): hot-reload via SIGHUP — env + quotas genlæses
  uden genstart.
- **FS-I7** (49a778a): chain archival med age-baseret compaction.

## 10. Næste kandidater (v2q) — ALLE LEVERET

- (a) Federation real-run audit-dashboard — FS-K1/FS-Z2 (`fed-audit-dash`)
- (b) Secrets rotation operator-endpoint + vault-status panel — FS-I5 + v2q-(b)
- (c) Archive restore-drill — FS-J3 (`chain-archive-restore`)
- (d) Tenant-scoped telemetry isolation — FS-I2 (`telemetry-tenant`)
- (e) Observability historiske snapshots — FS-K3 (`obsv-history`)
- (f) Quota usage alerts — FS-K4 (`quota-alerts`)

*Owner: Jonas · Genereret af convergence-agent efter wave v2h + PM-audit;
opdateret efter v2l; opdateret efter v2p; opdateret efter v2w.*

## 11. Wave v2w leveret (operator power pack)

Batch konvergeret på `main @ 0d7d274` — 886 tests / 580 pass / 252
pre-existing integration-test failures (NOT regressions). Fem slices
landet, alle env-gated, alle inline-implementeret efter z-ai/glm-5.3-flash
løb tør for OpenRouter-credits:

- **FS-W1**: Tenant activity tracking — `last_activity_at` + `total_ops`
  pr. tenant, /v2/tenants/inactive operator-view (default 30d threshold).
  TRANSPARENCY rows 185-186.
- **FS-W2**: Chain-prune real execution — safety-gated (min 1000 rows
  unless `force`), atomic snapshot+delete+manifest, /v2/chain/prune
  operator endpoint. TRANSPARENCY rows 187-188.
- **FS-W3**: Operator notification preferences — per-operator opt-in
  to audit event categories (store only, no delivery yet).
  TG_OPERATOR_NOTIFY=1, channels: audit_chain/webhook. TRANSPARENCY
  rows 189-191.
- **FS-W4**: Skill dependency graph validation — self-ref, cycle, missing
  dependency, invalid slug checks. Strict mode requires all slugs to
  exist. /v2/skills/validate-deps. TRANSPARENCY rows 192-193.
- **FS-W5**: Deep healthz endpoint — /v2/healthz/deep returns
  per-subsystem status (chain, db, disk, gateway). Public, no auth,
  no audit row.

---

## 12. Regression-elimination + live verification (2026-09-04)

De 252 "pre-existing" integration-test-fejl siden v2r var **ikke**
miljø-relaterede — de var strukturelle. Tre rodårsager, alle P0-fixet:

1. **Function-style mounts var dead code**: mounts 120-158
   (`module.exports = function mount(gw)`) kaldte `gw.router.get(...)`,
   men Gateway havde ingen router og `loadMounts()` kastede på
   funktions-eksports → alle gateway-spawning tests crashede ved load
   (~283 tests kørte aldrig). Fix: tolerant loader (skip + audit) +
   `gw.router` facade i server.js (66 routes live, dispatched før v1
   med bearer auth, `req.bot` sat for isOperator, `:param` matching).
2. **Z-wave overskrivelser**: FS-Z6 overskrev FS-I3 `tenant-quotas.js`
   (→ `getTenantQuotas is not a function`), FS-Z5 overskrev FS-I4
   `audit-export.js`. Begge originaler gendannet; Z-versioner flyttet
   til `tenant-resource-quotas.js` / `audit-export-jsonl.js`.
3. **Manglende eksports**: `events.audit()` (nu via hash-chain
   entryHash) + `tenants.isOperator()` tilføjet.

**Live-verifikation på :8800 (atlas operator / forge worker):**
- 8/8 fn-route GETs → 200 (metrics, fed-audit, skill-search,
  backup-crypto, operator-sessions, chain/verify, audit-export,
  tenant-metrics)
- RBAC-falsification: worker → 403, anon/bad-token → 401 (PASS)
- Mutation smoke: retention POST, webhook create/list/delete,
  rate-limits PUT/GET, sandbox PUT/GET, dashboard, notify → 200
- Tenant-isolation: iso-a webhook usynlig for iso-b; wildcard (*) som
  designet
- **Conformance tier-A: 9/9 domæner PASS** på live gateway
- Suite: **1356/1356 grønne** (fra 590 pass + 252 fail)
- Chain repaired: healthz ok:true, chain verify ok:true (1427+ checked)

systemd env aktiverer nu z-wave flags (TG_TENANT_METRICS,
TG_FED_AUDIT_DASH, TG_SKILL_MARKET_SEARCH, TG_CHAIN_INTEGRITY,
TG_AUDIT_EXPORT, TG_OPERATOR_SESSION_AUDIT, TG_ROUTE_LIMITS,
TG_WEBHOOK_SUBS_TENANT, TG_SKILL_SANDBOX, TG_OPERATOR_DASHBOARD,
TG_OPERATOR_NOTIFY). TRANSPARENCY: 252 rækker.

### Backup/restore drill (2026-09-04, live ops-verification)
- Latest automated backup (04:00, tg-backup.timer): **13/13 sha256 verified**
- Tampered backup → restore REFUSED fail-closed ("sha256 mismatch — refusing")
- Clean restore into throwaway dir → 13/13 files restored
- Live gateway unaffected (healthz ok:true throughout)

### Conformance tiers B+C + SQLite integrity (2026-09-04)
- **Tier-A: 9/9 domæner PASS** (live gateway :8800)
- **Tier-B: 3/3 PASS** (policy, secrets, ratelimits deep battery)
- **Tier-C: 4/4 PASS** (WAL concurrent writers, ENOSPC fail-closed,
  restart-storm 5×, disk-full runbook)
- SQLite integrity_check: ok — 2212 chain entries, 2.5MB
- Suite: **1362/1362 grønne** (inkl. nye fn-route dispatch contract tests)

## 13. fn-route shadowing-audit + rate-dashboard (2026-09-06)

### fn-route shadowing-audit (live falsificering, baskets-metoden udbredt)
Systematisk audit af alle 66 fn-routes: registreret path-template vs intern
`req.url.match`-regex + param/static-kollisionsanalyse (første-match-vinder i
registreringsrækkefølge).
- **FUNDET: `GET /v2/federation/audit` shadowed** — registreret i BÅDE
  mounts/120 (FS-K1, gate TG_SKILLS_FEDERATION, altid vinder) og mounts/153
  (FS-Z2, gate TG_FED_AUDIT_DASH, aldrig nået). Live havde TG_FED_AUDIT_DASH=1
  men IKKE TG_SKILLS_FEDERATION → korrekt handler var utilgængelig, request
  fik 404 fra den forkerte handler.
- Fix: 153's sti flyttet til `/v2/federation/audit/events` (unik);
  TRANSPARENCY række 212 opdateret. PR #28 → merged 036c21f, main-CI success.
- Ny regressions-test `tests/fn-route-no-shadow.test.js`: ingen to fn-routes
  deler method+path; hver registreret route dispatcher til sin handler
  (5 tests, kører med gateway-dispatch-contract).

### Rate-dashboard (backend + konsol, fuldstack)
- Backend: `rate-ledger.listCurrent(windowMs)` — nuværende-vindue buckets
  sorteret efter count; ny operator-route `GET /v2/rate/buckets`
  (auditeret `rate_buckets_read`; count only, ingen bucket-indhold —
  anti-identitet). Mount 129, FS-M3.
- Konsol: nyt panel "Rate" (`app/panels/rate.js`) — live buckets + route
  limits via TG.api, 30s auto-refresh, textContent-only (XSS-politik).
- Tests: `tests/rate-buckets-dash.test.js` (4: list/rank, 403 non-operator,
  404 disabled, 400 invalid windowMs) + 2 listCurrent-unit-tests;
  30/30 grønne sammen med nabo-suiter.
- TRANSPARENCY: ny række 168 `rate_buckets_read`; `rate_bucket_reset` → 170.

## 14. Route-limits enforcement færdiggjort (2026-09-06)

Rate-dashboardet (PR #30) afslørede ved live-verifikation at FS-X3-regler
var **dekorative**: `/v2/rate/limits`-reglerne blev aldrig håndhævet —
intet kaldte `check()` i request-flowet (mount 148 er CRUD-only). Tre
lag lå:

1. **PR #31** — `match()` dobbelt-lookup: bare-path rules (`/v1/actions`,
   dokumenteret set()-format) var døde (kun method-prefixed key fundet).
2. **PR #32** — `server.js._enforceRouteLimit()` efter token-budget på
   alle tre overflader (fn-routes, plugin-mounts inkl. auth:'none' med
   intern auth via dobbelt-lookup, legacy v1); 429 `route_rate_limited`
   audit-sealet (TRANSPARENCY række 281); lazy require mod test-cache.
3. **Ops** — live env manglede `TG_RATE_LEDGER=1` (ledger altid disabled);
   aktiveret i data/gateway-systemd.env (gitignored) + restart.

### Live-verifikation (main f86604c, :8800)
- Regel `GET /v2/whoami` maxHits=1 via PUT /v2/rate/limits
- Kald 1 → 200 · Kald 2 → **429 `route_rate_limited`** med pattern +
  retryAfterMs (50699) + count
- rate-buckets viste `GET:/v2/whoami count 2` i nuværende vindue
- Audit-seal bekræftet i SqlChain: `route_rate_limited {bot, pattern, path}`
- Regel slettet igen (DELETE /v2/rate/limits/… → removed:true)
- Nettoeffekt: `/v1/actions`-reglen (60/min, opsat tidligere) ER nu
  reelt håndhævet — tidligere silent no-op

## 15. Sandbox OS-lag live-aktiveret (2026-09-06)

FS-F3 (bwrap/unshare/systemdRun-wrapping, strict additive) havde ligget
i kode siden spike men var aldrig tændt i produktion. Aktivérbarheds-
tjek på live-host: `detectSandboxSupport()` → bwrap=true, unshare=true,
systemdRun=true; `wrapCommand()` → wrapped=true method=unshare.
`TG_SANDBOX=1` nu sat i data/gateway-systemd.env (gitignored) + restart;
process-env verificeret live (PID-environ viser TG_SANDBOX=1 +
TG_RATE_LEDGER=1). Sandbox-suiter 22/22 grønne.

## 16. Rate-panel endelig synligt + orphan-panel-audit (2026-09-06)

Rate-panelet (PR #30) var dobbelt-orphanet: (1) script-tag manglede i
index.html, (2) domæne-registrering manglede i core.js (konsollen er
to-lags: script + DOMAINS/TABS_LEGACY). Samme skæbne for cards.js
(apr-123) og secrets.js. Fixes:
- PR #35: index.html-script for rate + cards + regressionstest (hver
  paneler/*.js skal have script-tag)
- PR #36: core.js-wiring — rate→CONTROL, cards→CHAT, secrets→SYSTEM;
  PANEL_TITLES_EXTRA (titler uden at bryde den verbatim 13-tab
  TABS_LEGACY, panel-core-test enforcer)
- Browser-verifikation (frisk session, atlas-operator): CONTROL →
  subtabs "Computer | Rate" → panel renderer
  "RATE LIMITS & BUCKETS" med /v1/actions 60/s 60s + live bucket
  POST:/v1/actions count 2 efter 2 hits + Refresh (60s window,
  timestamp) — fuld backend→ledger→API→konsol-kæde levende.

### Audit-støj `mounts_function_style_skipped` (undersøgt, lukket)
4999/5000 rækker stammer fra 09-04 (FØR dedupe-fixet i http-mounts.js);
siden da 1 entry per skip-sæt-ændring. Skip-sættet = fn-style-mounts
120+ (ved design). Ingen ændring nødvendig; ikke historie-omskrivning
(chain-integritet > skønhed).
## 17. Konsol-auth E2E lukket + rate-alerts live (2026-09-06)

### Konsol-auth E2E (T1) — 8 PRs, browser-verificeret
- **PR #38** (4396e71): registrering var åben + første bruger fik implicit
  `owner` (firstUserRole-bootstrap = latent eskalation). Nu
  `TG_AUTH_OPEN_REGISTER=0` → `403 registration_closed` +
  `user_register_refused`-seal; `TG_FIRST_USER_ROLE=member`. Gating-bevis:
  cookie-bruger → alle data-routes 401.
- **PR #39** (355ef8f): konsol-login var 100 % dødt — POSTede `/v2/auth/signup`
  + `username`, gateway har kun `/register` + `email`. Rettet til kontrakten.
- **PR #40** (d7f8b69): race — sent boot-authMe (401) overskrev frisk
  login-chip. Last-writer-wins-guard.
- **PR #41** (7afee0f): statiske assets uden cache-headers → heuristisk
  caching; `cache-control: no-cache` på static-path.
- **PR #42** (7ac6be5): CI-flake = bloat-guard-testens 12.500 SQLite-inserts →
  timeout i parallel CI. Tærskler læses ved kald-tid (env 5/50 i test).
- **PR #43** (f3b8688): SW cache-first + VERSION aldrig bumped → evigt gammel
  konsol. Rollout injicerer deploysha i SW-versionen.
- **PR #44** (7bb00b4): sidste cache-hul — `/auth.js` serveres af separat mount
  med egen `writeHead` uden no-cache. Delegeret til fælles static-vej.
- **PR #45** (557231b): `authMe` returnerede `{user:{...}}` men chip læste
  `me.display_name` → chip kunne ALDRIG vise navnet. Unwrap-fix.

Browser-E2E (frisk session): overlay auto-åbner ved 401 → login →
chip "Probe User" + logout → stabil efter 2.5s (ingen race). Testbruger
slettet, sessioner ryddet, gateway restarted.

### Rate-alerts (T2) — PR #46 (1bdd0d2), live-verificeret
- `rate_bucket_near_limit` (TRANSPARENCY 282): audit-seal PRÆCIS én gang pr.
  vindue, når bucket krydser 80 % (`count === floor(maxHits*0.8)`).
- `/v2/rate/buckets` enrich: `maxHits` + `nearLimit` pr. bucket (console
  skal ikke re-derivere regler client-side).
- Konsol: pulserende ⚠-badge på nær-limit buckets.

Live-verifikation (:8800, main 1bdd0d2):
- 48× POST /v1/actions → `{"maxHits":60,"nearLimit":true}` i buckets-API
- Præcis 1 seal `rate_bucket_near_limit {count:48, maxHits:60}` i chain
- Bucket reset (removed:3) → 0 buckets, live-ren

Ops-notat: rollout.sh fejlede stille på stale branch-config
(`t2-rate-alerts` slettet ved squash → `git pull --ff-only` FEJLET, rollout
abortede uden at fejle). Redning: `git checkout -B main origin/main` →
rollout OK. Pitfall logget.
## 18. Rate-alert notifikationer (webhook-push) live (2026-09-06)

### PR #47 (fb6b209) + ops-fix PR #48
- Når `rate_bucket_near_limit`-sealet krydses (80 % af maxHits), fan-out til
  FS-L2 webhook-subs via `notify-delivery.deliver(...)` — fire-and-forget
  efter audit-seal (try/catch + .catch(()=>{}), nul latency-tillæg på
  rate-stien).
- notify-delivery: L2-webhook-subs leveres nu også uden operator-pref-række —
  de registrerede eventTypes ER abonnementet (operatør-managed URLs,
  dokumenteret i koden). Eksisterende prefs-gate for `audit_chain`-kanalen
  uændret.
- Ops: TG_NOTIFY_DELIVERY=1 + TG_WEBHOOK_SUBS=1 live (TG_OPERATOR_NOTIFY
  allerede aktiv).
- Live-verifikation (:8800): webhook-sub (127.0.0.1:8799, eventTypes
  [rate_bucket_near_limit]) → 48× POST /v1/actions → præcis 1 POST
  `{type:"rate_bucket_near_limit", payload:{bot:"atlas", pattern:"/v1/actions",
  count:48, maxHits:60, windowMs:60000}}` → sub slettet, bucket reset.
- Tests: rate-alert-notify.test.js — (a) webhook-E2E med lokal http-server
  (1 leverance, korrekt payload, seal i chain), (b) inert uden
  TG_NOTIFY_DELIVERY (ingen POST, seal fortsat durable). Suite 1824/1824.
- Ops-arv: rollout.sh SW-version-bump var kun baseline-matchet (w9.1.0) —
  dirty sw.js efter tidligere kørsel = stille sed-no-op → rollout exit 1
  midt i kæden. PR #48: idempotent `[^']*`-match.
## 19. Reaktiv rate-alert UX i konsollen (2026-09-06)

### PR #49 (6509912) + visningsfix PR #50 (af1eff0)
- Rate-panelet fik en 'Near-limit alerts (24h)'-sektion: tæller + seneste 12 seals fra `/v2/federation/audit/events?type=rate_bucket_near_limit&since=<24h>` (153-fed-audit-dash — ingen ny backend).
- SSE-reaktivitet: panelet åbner `EventSource /v2/events?token=` (query-param, auth:'query'); en `rate_bucket_near_limit`-frame triggerer øjeblikkelig refresh af buckets + alerts — ingen op til 30s poll-vent. Stream lukkes ved re-render.
- XSS: textContent-only (source-level test forbyder element-html-APIs).
- Live-fund under verifikation: `fmtCount()`-misbrug viste '—' i stedet for count (PR #50, regressionstest).
- Tests: 7 nye (rate-panel-alerts.test.js, VM-sandbox + kildekode-kontrakter); suite 1830/1830 grøn; CI begge PRs parat.
- Live-bevis: 58× POST pust → panelet opdaterede (~2s, uden Refresh-klik) → "⚠ 3 near-limit alerts (24h)" + bucket "POST:/v1/actions 58 ⚠ near-limit (60/s max)" + alle rækker viser count 48.
## 20. SSE-resiliens: ticket-exchange + global near-limit badge (2026-09-06)

Arkitektur-review-feedback (Jonas): token-i-URL lækker i proxy-logs/browserhistorik,
burst-frames skaber backpressure, 401-reconnect thrash, payload-normalisering manglede.
Prioritering: resiliens (4 tiltag) + global badge = top; Telegram-notify + ROLLOUT-LOG-eksport = §21-kandidater.

- Backend — `POST /v2/events/ticket` (11-events-ticket.js + events-ticket.js): bearer-autentificeret mint af 30s single-use nonce (crypto-random 64 hex, in-memory TTL) med tenant-CLAIM (`tnt_<id>_ticket` — aldrig token-materiale). `/v2/events` tager nu `?ticket=` (server.js query-auth: ticket-branch); `?token=` på events = fail-closed 401. Andre query-auth-mounts (10-search) beholder `?token=` via `mount.queryAuth`-politik (kun SSE kræver ticket).
- Fælles klient `app/events.js` (TG_EVENTS): ticket-exchange med Authorization-header, 401/403 → permanent stop (onAuthExpired — ingen reconnect-thrash), netværksfejl → backoff 3s→30s (5 retries), ny ticket pr. genoprettelse (single-use), idempotent open() + subscribe/unsubscribe + onStatus('open'|'reconnect').
- `app/panels/rate.js`: trailing debounce 400ms på seal-frames (burst → ét UI-fetch), AbortController bundet til render (stream + udestående fetches afbrydes synkront), normalisering i fetch-laget (`normalizeAlertCount` type-guard: number eller {count}-objekt).
- Global badge `app/alert-badge.js`: gul `⚠ N near-limit` i NOW-stripet — 24h-tæller ved boot (153-fed-audit-dash), live +1 pr. near-limit-frame via TG_EVENTS, skjult ved 0, klik → TG_CORE.switchTab('rate').
- Live-fund under verifikation (4 ops-fixes, 4 PRs):
  - #52: static asset-allowlist (server.js) dækkede ikke nye root-filer (events.js/alert-badge.js) OG manglede lib/*, auth.js, tenant-picker.js — alle 404. Allowlist udvidet + anti-drift-test: enhver script-src i index.html skal matche server-allowlisten.
  - #53: connect() kaldte `es.close()` efter at §20 havde fjernet `let es` → ReferenceError ved boot → konsollen død (window.TG aldrig sat). Regressionstest: es.close() kræver es-deklaration.
  - #54: alert-badge.js loadede FØR app.js → boot-fetch med tom token → 401 → badge 0 trods total=3. Script flyttet sidst i index.html.
  - #55: badge-klik brugte `window.jumpTab` — den er en closure, ikke global. Skiftet til TG_CORE.switchTab('rate').
- Tests: +15 (sse-ticket E2E: mint→stream→replay-401→gibberish-401→?token=-401; events-client 7 VM-kontrakter; alert-badge 5; rate debounce/abort/normalisering; allowlist-anti-drift; es-orphan-guard; 5 testfiler migreret til ticket). Suite 1846 tests / 0 fail. CI grøn på alle 5 PRs.
- Live-bevis: mint → frisk stream 200; replay 401; ?token= 401; badge "3 near-limit" ved åbning → 48× POST pump → **"4 near-limit" ~2s senere** (SSE, før 30s-pollen); klik → Rate-panelet åbner. Live på 9aa1980.
- Git-hygiejne: `branch.main.pushRemote origin` + `remote set-head origin -a` låst; rollout.sh fik pre-push remote-guard (fork-remote → abort); CDP-timeout-notat i skill.
