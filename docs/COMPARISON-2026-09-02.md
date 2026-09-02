---
status: draft-v1
verified_against: web research 2026-09-02 (docs.x.ai, copilotkit.ai/openbot, github.com/CopilotKit/OpenBot, local AVC/Hermes state)
related: docs/TRUST-GATEWAY-V1.md
---

# Agent Workforce — Sammenligning: Grok Bot × OpenBot × Hermes/AVC

## 1. De tre spillere

### Grok Bot (xAI) — arketype #1 + #3, distriberet via abonnement
- **Produkt:** "AI teammates that finish the work". Bots med navn, job, durable
  samtale, arbejdskontekst der vokser over tid, egne routines på skema, og
  "Grok Bot's own computer" der logger ind i dine værktøjer via UI.
- **Multi-bot:** gruppechats hvor bots passerer arbejde imellem; én bot kan
  foreslå/oprette en ny fokuseret bot.
- **Memory:** stabil working-preferences + fakta + summaries pr. bot; correctness-
  advarsel i docs: memory ≠ authoritative source.
- **Distribution:** inkluderet i Cursor/SuperGrok/Teams-planer. Grok 4.6 model.
- **Svaghed:** shared computer på tværs af bots (docs indrømmer: "Shared computer
  files and sign-ins are not isolated by Bot"). Ingen åben protokol, ingen
  self-host, sort boks for audit.

### CopilotKit OpenBot — produktet er reelt governance-laget
- **Produkt:** self-hostet enterprise-platform; hver coworker = egen container,
  egen browser-profil, eget /workspace (valgfrit gVisor-runsc).
- **Kernepåstand:** "Every action decided **before** it happens and recorded
  **after**" — ÉN gateway for computer/fil/MCP/component; policy engine + audit
  trail er førsteklasses objekter. Hemmeligheder: write-only storage, audit
  logger kun karakterantal, aldrig værdier.
- **Protokol:** AG-UI ("bring any agent") — CopilotKit ejer protokollen,
  governance følger protokollen ikke frameworket.
- **Coworkers:** durable profiler = configuration (`agents.yaml` / UI), ikke kode.
  Fail-closed permissions ( Drive/OneDrive med arvede tilladelser, citerede svar).
- **Kræver:** Docker, Postgres+pgvector, Bun, CopilotKit Intelligence-licens
  (gratis-plan findes), model-nøgle. ~1.7k stars, v0.0.x — meget ung.
- **Svaghed:** tung self-host-ops, licens-afhængighed, ingen færdig
  forretnings-pakke — kunden skal stadig bygge workfen selv.

### Hermes bots / AVC-rosteren — kombinationen, allerede kørende
- **Produkt i dag:** profiler som bots (atlas/forge/judge/avc) med hver sin
  .env, SOUL.md (personlighed), persistent memory, model-routing inkl.
  provider-fallback-kæde (= arketype #4 løst), multi-platform gateway
  (Telegram m.fl.), A2A bot-til-bot, kanban work-queue, cron-routines.
- **Bevis:** denne konto kører reelt sådan — AVC roster + fleet af Hermes-
  gateways på VDS; fallback-kæden (Dialagram → Ollama Cloud → OR free → OCZ
  free) blev bygget og verifieret i dag.
- **Huller mod OpenBot:** ingen unified action-gateway med fail-closed policy,
  ingen tamper-evident audit chain, ingen write-only secret-håndtering,
  approvals er per-tool-flag ikke et centralt lag.

## 2. Feature-matrix

| Evne | Grok Bot | OpenBot | Hermes/AVC i dag |
|---|---|---|---|
| Persistente bots med navn/rolle/memory | ✅ | ✅ (profiler) | ✅ (SOUL.md + memory) |
| Visuel builder uden kode | ❌ | ⚠️ config/UI-yaml | ❌ |
| Egen computer pr. bot | ⚠️ delt | ✅ isoleret | ⚠️ delt VDS pr. profil |
| Handlinger gate decisions før + audit efter | ❌ | ✅ kærgaranti | ❌ |
| Fail-closed policy engine | ❌ | ✅ | ❌ |
| Tamper-evident audit chain | ❌ | ⚠️ audit rows (Postgres) | ❌ |
| Write-only secrets | ❌ | ✅ | ⚠️ auth.json 0600 |
| Multi-model routing + fallback | ❌ (kun Grok) | ⚠️ pr. agent | ✅ provider-kæder |
| Any-agent protokol (open) | ❌ | ✅ AG-UI (deres) | ⚠️ OpenAI-compat + A2A |
| Bot-til-bot opkvalificering/grupper | ✅ | ❌ | ✅ A2A + kanban |
| Routines/scheduling | ✅ | ❌ | ✅ cron |
| Self-host / data-ejerskab | ❌ | ✅ | ✅ (ejer selv infra) |
| SMB-færdigpakke (ingen ops) | ⚠️ forbruger- UX | ❌ | ❌ (kun vores egen) |

## 3. Positionering — hvor kombinationen ligger

De fire arketyper er each-and for sig tabte eller commoditiserede:
#1 vinde xAI på distribution, #3 giver de væk i abonnement, #4 ejer OpenRouter,
#2 er Lovable-red ocean. Den ubesatte plads er **laget mellem #1, #3 og #4**:

> **A styret AI-workforce som produkt:** specialist-bots (persona + memory),
> hver med isoleret computer, samlet provider-routing, og ett governing
> action-gateway der beslutter før og beviser bagefter — leveret som færdig
> løsning til virksomheder der ikke vil self-hoste og ikke kan køre xAI's sort box.

OpenBot bygger præcis denne thesis open-source og overlader ops'en til kunden.
Det kommercielle hul er **hosted workforce med OpenBot's garantier** — vi kalder
laget **Trust Gateway**. Det er det lag, Hermes-rosteren mangler, og det er
v1 vi bygger (se docs/TRUST-GATEWAY-V1.md + src/gateway).

## 4. Pitch ("sælg mig det")

**One-liner:** *Ansett en AI-workforce du faktisk kan slippe løs på dine systemer
— hver bot har sin egen computer, hver handling bliver vurderet før den sker og
forseglet efter, og du kan skifte hjerne (model) uden at ændre autoritet.*

| | Grok Bot | OpenBot | Trust Gateway (os) |
|---|---|---|---|
| Pris model | Abonnement, sort boks | Gratis kode, dyr ops | Hosted, per-workforce |
| Garantier | "trust us" | dine folk skal køre det | garante + vores drift |
| Data | xAI | egen Postgres | tenant-isoleret, EU-hosted |
| Models | kun Grok | egen nøgle pr. agent | routing + fallback-kæde |

**Hårde tal (i dag, kørende system):** 5 profiler, 4 verificerede
provider-kilder i live fallback-kæde, 1 gateway-implementering af v1 bygget og
testet samme dag som dette dokument.

**Moat:** xAI kan ikke kopiere self-host-trust uden at Kannibalisere deres
abonnement. CopilotKit kan ikke kopiere færdig SMB-pakke uden at blive
serviceselskab (deres model er license + protocol lock-in). Vi står midt imellem
med kørende bevis — AVC-rosteren er vores egen første kunde (dogfooding).
