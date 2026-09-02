# Agent Workforce — Trust Gateway v1

En styret AI-workforce: specialist-bots (persona + persistent memory), hver med
isolerede værktøjer og model-routing — samlet bag én **Trust Gateway** der
beslutter hver handling **før** den sker (fail-closed) og forsegler den i en
tamper-evident audit chain.

Positionering: se `docs/COMPARISON-2026-09-02.md` (Grok Bot × OpenBot × Hermes).
Design: `docs/TRUST-GATEWAY-V1.md`.

## Komponenter

| Modul | Formål |
|---|---|
| `src/gateway/hash-chain.js` | Append-only audit chain (sha256-kædet, replay-beskyttet genesis) |
| `src/gateway/policy.js` | Fail-closed classification + decision (read/write/destructive/secret) |
| `src/gateway/approvals.js` | Menneske-approvals med TTL, fail-closed på expiry |
| `src/gateway/server.js` | HTTP API med write-ahead audit (decision logges FØR dispatch) |
| `src/gateway/client.js` | Zero-dependency Node client SDK (GatewayClient) |

## Garantier i v1

1. **Ukendt tool = destruktiv** (fail closed) → kræver menneske-godkendelse
2. **Destructive aldrig auto-eksekveret** — heller ikke med capability
3. **Secret-værdier nå aldrig audit** — kun længde logges
4. **Write-ahead audit** — også refusals og crashes er på rekord
5. **Tamper-evident** — én ændret byte i historikken bryder alle efterfølgende hashes
6. **Approvals expire fail-closed** (15 min TTL)

## Kør

```bash
npm test          # unit + integration tests (node:test, 0 dependencies)
npm run demo      # live HTTP-demo: fuldt bot-workflow inkl. tamper-detektion
```

Demo-output (verificeret 2026-09-02):

```
✔ unauthenticated → 401
✔ read allowed
✔ write (capability) executed
✔ destructive → 202 needs_approval
✔ destructive NOT executed
✔ deny blocks execution
✔ approve → executed
✔ secret value NOT in audit
✔ audit chain verifies  → length=15
✔ tampering detected  → at seq 2 (hash_mismatch)
✔ healthz (no auth)
★ DEMO PASSED — all checks green
```

### Bot SDK

En zero-dependency Node-client (`src/gateway/client.js`) pakker den dokumenterede
HTTP API op i en `GatewayClient`-klasse. Netværks- og parse-fejl kaster;
HTTP-fejl (401/403/202/502) returneres som et resolved objekt med `error` eller
`decision`, så klientkoden kan grense uden try/catch omkring hver call.

```js
const { GatewayClient } = require('./src/gateway/client');
const gw = new GatewayClient({ baseUrl: 'http://100.71.253.52:8800', token: process.env.TG_TOKEN });
const r = await gw.action('fs.read:notes/x.md');
```

Metoder: `action(tool, args?)`, `pending()`, `approve(id)`, `deny(id)`, `verify()`,
`audit(since=0)`. Se `example/bot.js` for en komplet read → write → needs_approval →
human-in-the-loop workflow.

## Vejen videre (ikke committed, kun vision)

- v2: container-isolation pr. bot (gVisor), persistence af approvals, TLS
- ADR: AG-UI vs. OpenAI-compat som agent-protokol
- Hosted multi-tenant edition (SMB-pakken)