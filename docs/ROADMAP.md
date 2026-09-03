# Trust Gateway — Roadmap v3 (2026-09-03)

Status basis: `main @ 56765dd` — 916/916 tests grønne, tier-A 9/9 domæner,
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

## 8. Næste kandidater (v2m)

- (a) Skills shared på tværs af tenants — kræver en federation-design-
  beslutning (hvem ejer en delt skill? hvordan spores den i chainen?)
- (b) Observability-dashboard: G12-telemetry-ring + chain-længde +
  apikey-rate-tællere i ét operator-panel
- (c) Multi-signal alarmering: watchdog → webhook (Tailscale/Telegram)
- (d) Self-host dokumentation til eksterne kunder (install.sh + RUNBOOK
  som kundevendt docs)

*Owner: Jonas · Genereret af convergence-agent efter wave v2h + PM-audit;
opdateret efter v2l.*
