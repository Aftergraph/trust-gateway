---
status: v1-implemented
date: 2026-09-02
related: docs/COMPARISON-2026-09-02.md
---

# Trust Gateway v1 — design & implementation notes

## Formål
Laget der gør en AI-workforce "slip-løs-værdig": én gateway mellem bots og
deres værktøjer der (a) beslutter hver handling **før** den udføres (fail-closed
policy), (b) forsegler hver handling i en tamper-evident audit chain, og (c)
kan delegerer beslutningen til et menneske via approvals.

## Arkitektur (4 moduler, 0 dependencies)

1. **`src/gateway/hash-chain.js`** — tamper-evident audit chain.
   Hver entry: `{seq, prevHash, ts, payload, hash}` hvor
   `hash = sha256(seq | prevHash | ts | canonicalJSON(payload))`.
   `verifyChain()` genberegner hele kæden; en enkelt flipped byte i noget
   historik gør alle efterfølgende hashes ugyldige.
   Genesis-entry seedes med per-instans `chainId` (random ved opstart) så to
   gateways aldrig deler genesis og man ikke kan replaye entries på tværs.

2. **`src/gateway/policy.js`** — fail-closed action policy.
   Hver bot-action klassificeres i `read | write | destructive | secret` via
   rule table; regler kan matches på præfiks (`fs.write:*`). Unknown tool =
   `destructive` (fail closed). Decision matrix:
   - `read` → allow
   - `write` → allow hvis bot'en har capability, ellers `needs_approval`
   - `destructive` → altid `needs_approval` (bot kan aldrig selv)
   - `secret` → `deny` medmindre approval + capability; audit logger kun
     **karakterantal** af hemmeligheden, aldrig værdien (OpenBot-mønster).
   Capabilities pr. bot: `["fs.read", "fs.write", "shell.run", ...]` —
   default: `["fs.read", "web.get"]`. Role-based grant ved oprettelse.

3. **`src/gateway/approvals.js`** — mennesker i loopen.
   `needs_approval` → request med TTL (default 900s). Approve/deny med
   grun; expired requests fail closed. Approval event skrives i audit-kæden
   med approver-id.

4. **`src/gateway/server.js`** — HTTP API (node:http, ingen deps).
   - `POST /v1/actions` — bot foreslår handling → policy decision +
     (hvis tilladt) eksekvering via dispatchere + audit-entry
   - `GET /v1/audit?since=N` — pagineret audit
   - `GET /v1/audit/verify` — kæde-verifikation (hashes + seq)
   - `POST /v1/approvals/:id/approve|deny`
   - `GET /healthz`
   Auth: statisk bearer-token per bot (`BOT_TOKENS` env, format `name:token`).
   Ukendt token = 401 + audit-entry. Alle svar er JSON. Audit går altid først
   (write-ahead): beslutningen logges **før** dispatcheren kaldes, så også
   refusals og crashes er på rekord.

## Hvad v1 bevidst IKKE har (YAGNI)
- Ingen container-isolation pr. bot (kommer i v2; v1 beviser gateway-laget)
- Ingen AG-UI (open protokol-valg er en separat ADR)
- Ingen persistence ud over append-only audit file (`data/audit.jsonl`,
  atomisk fsync pr. entry)
- Ingen TLS (bag nginx/caddy i drift; v1 er localhost/fleet-intern)

## Definition of Done v1
- [x] Fail-closed: ukendt tool → destructive → needs_approval
- [x] Destructive aldrig auto-allow, heller ikke med capability
- [x] Secret-værdier nåede aldrig audit (kun længde)
- [x] Kædeverifikation fanger tampering (testet: mutation → verify=false)
- [x] Approvals: approve / deny / expire, alle med audit-spor
- [x] Auth: ukendt token afvises og logges
- [x] 15+ unittests grønne (node:test)
- [x] Live roundtrip: server op, allow + deny + approval-flow gennemgået