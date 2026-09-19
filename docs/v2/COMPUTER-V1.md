---
status: current
version: 1.0.0
authority: implementation
date: 2026-09-19
---

# Aftergraph Computer v1

Computer v1 extends the existing governed `ComputerSession` surface with a
provider-neutral host capability seam. It does not make Trust Gateway a shell
daemon and it does not embed vendor SDKs.

## Canonical objects

- **ComputerSession** — governed interaction session; existing hash-chained frame stream.
- **ComputerProvider** — runtime adapter metadata for one execution/observation provider.
- **ComputerCapability** — canonical action or observation name.
- **ComputerFinding** — sanitized health observation with evidence references only.

Providers are runtime implementations, not product authorities. Current intended
mappings are:

| Provider | Primary responsibility |
|---|---|
| `desktop-commander` | files, shell, persistent terminal sessions, processes |
| `cua-driver` | screen, windows/UI tree, mouse/keyboard computer use |
| `native` | platform-specific trusted host probes |
| `playwright` | browser-scoped automation |
| `custom` | future adapters conforming to this contract |

## API

### `GET /v2/computer/providers`

Operator-only. Returns sanitized provider projections:

```json
{
  "providers": [{
    "id": "dc-local",
    "kind": "desktop-commander",
    "version": "0.2.51",
    "nodeId": "jonas-lenovo",
    "capabilities": ["computer.health.inspect", "computer.process.list"]
  }]
}
```

Provider endpoints, credentials, adapter objects, command arguments, and secrets
are never projected.

### `POST /v2/computer/inspect`

Operator-only composite read surface.

```json
{"scope":"health","depth":"forensic"}
```

Supported depths: `quick`, `standard`, `forensic`.

No attached health provider returns HTTP 503 with
`unavailable:true` and an empty findings array. The gateway never fabricates
health findings.

## Findings

A finding is deliberately small:

```json
{
  "type": "orphan_process",
  "severity": "warning",
  "summary": "orphan node process detected",
  "evidenceRefs": ["process:18424", "eventlog:abc"],
  "recommendedCapability": "computer.process.stop",
  "providerId": "dc-local",
  "nodeId": "jonas-lenovo"
}
```

Raw command output, command lines, screenshots, secrets, and evidence bodies are
not accepted into the projection. Those belong behind referenced evidence stores.

## Canonical capability namespace

Observation:

- `computer.health.inspect`
- `computer.process.list`
- `computer.process.inspect`
- `computer.files.read`
- `computer.shell.output`
- `computer.screen.capture`
- `computer.window.list`
- `computer.window.inspect`
- `computer.ui.inspect`

Effectful:

- `computer.process.stop`
- `computer.files.write`
- `computer.shell.start`
- `computer.shell.send`
- `computer.shell.stop`
- `computer.input.click`
- `computer.input.type`
- `computer.input.scroll`

The capability namespace is the stable Aftergraph ABI. Provider-specific MCP tool
names are implementation details.

## Security invariants

1. Provider metadata is operator-only because host topology is sensitive.
2. Provider secrets/endpoints/adapters never enter API projections.
3. Health inspection returns sanitized summaries plus evidence references.
4. Unknown capabilities fail closed at provider registration.
5. Missing providers produce `unavailable`; the gateway never substitutes
   synthetic success.
6. Provider failure is explicit and may produce a partial result.
7. Existing `ComputerSession` takeover/release and hash-chain semantics remain
   authoritative for human control and live follow-along.
8. Trust Gateway remains zero-dependency and provider-neutral.

## Runtime boundary

Computer v1 keeps provider execution outside Trust Gateway. A physical Computer Node may
run DesktopCommanderMCP, Cua Driver, native Windows probes, or another provider.
Trust Gateway attaches an external node when `TG_COMPUTER_NODE_URL` and
`TG_COMPUTER_NODE_TOKEN` are both configured. The token and URL remain private
runtime configuration and never enter provider projections. Transport, device
identity, and node heartbeat are separate runtime concerns and must not grant
authority by themselves.

Target data flow:

```text
FIHIM / agent / operator
          |
          v
     Trust Gateway
          |
   ComputerSession
          |
 capability + authority
          |
   provider registry
      /        \
DesktopCmdr   Cua Driver
      \        /
       Computer Node
```

## Verification scope for v1

The implementation ships with tests for:

- manifest validation and canonical capability allowlisting;
- provider projection secret/adapter non-disclosure;
- sanitized finding projection;
- partial provider failures;
- fail-closed no-provider behavior;
- operator-only HTTP provider/inspection surfaces;
- audit-chain integrity on refused worker access.

Production readiness additionally requires a real Computer Node adapter and
exact-head CI evidence.

## Computer Node v1

The first node implementation lives in `Aftergraph/runtime/packages/computer-node`.
It exposes an authenticated loopback-first HTTP protocol:

- `GET /v1/manifest`
- `POST /v1/inspect`

Its built-in `native-windows` provider performs read-only PowerShell/CIM health
inspection. Arbitrary remote shell execution is intentionally not part of v1.
