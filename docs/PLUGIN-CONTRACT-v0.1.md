# Plugin Contract v0.1

## Purpose

Define a declarative mechanism by which plugins can declare:
- UI primitives they may render
- Tools they may expose
- Events they may subscribe to/publish
- Automations they may register

All consequential actions still pass through Trust Gateway (TG) / Adaptive Infrastructure Engine (AIE) for policy enforcement.

---

## Manifest Schema

```json
{
  "id": "plugin-id",
  "name": "Plugin Name",
  "version": "1.0.0",
  "entry": "index.js",
  "description": "Short description (≤200 chars)",
  "permissions": ["read", "write", "approval.decide/*"],
  "tools": ["tool.name", "tool.*"],
  "views": ["Card", "Table", "Form", "Chart", "Timeline", "Approval", "Progress", "Artifact"],
  "events": ["event.name", "event.*"],
  "automations": [
    { "id": "auto-1", "trigger": "event.name", "condition": "...", "action": "tool.name" }
  ],
  "sandbox": "jailed"
}
```

### Fields

| Field        | Type      | Required | Description                                    |
|--------------|-----------|----------|------------------------------------------------|
| id           | slug      | Yes      | Lowercase slug [a-z0-9][a-z0-9._-]*            |
| name         | string    | Yes      | 1-64 chars                                     |
| version      | semver    | Yes      | x.y.z format                                   |
| entry        | file      | Yes      | Relative .js entry point                       |
| description  | string    | No       | ≤200 chars                                     |
| permissions  | array     | No       | Declared capabilities (see below)              |
| tools        | array     | No       | Tool patterns this plugin may invoke           |
| views        | array     | No       | UI primitives this plugin may render           |
| events       | array     | No       | Event patterns to subscribe to                 |
| automations  | array     | No       | Auto-actions triggered by events               |
| sandbox      | string    | Yes      | Must be "jailed"                               |

---

## Permission Model

### Plugin-Declared Permissions (Read-Only / Low-Impact)

Plugins can declare:
- `read:*` — Read access to data
- `tool.name` — Declare tools they intend to use

### Requires TG/AIE Approval (Consequential Actions)

**Any** of the following always requires explicit TG/AIE approval:
- `write:*` — Write operations
- `destructive:*` — Destructive operations
- `approval.decide/*` — Approval actions
- `tool.*` with side effects — Tool invocations with consequences

**Contract Rule:** A plugin may declare permissions in its manifest, but actual enforcement is performed by TG/AIE policy at execution time. Declared permissions are for visibility; they do not grant automatic access.

---

## UI Declaration Format

Plugins may declare views using the 8 primitives:

| Primitive   | Use Case                              |
|-------------|---------------------------------------|
| Card        | Single-item display                   |
| Table       | Multi-item listing                    |
| Form        | Input collection                      |
| Chart       | Data visualization                    |
| Timeline    | Temporal sequence display             |
| Approval    | Approval UI rendering                 |
| Progress    | Status/progress indicators            |
| Artifact    | File/binary output display            |

### Expansion Rules

1. **Allowed List**: Only primitives explicitly declared in `views[]` may be used.
2. **No Implicit Expansion**: Declaring `Card` does not grant `Table`.
3. **Runtime Validation**: TG validates view usage at render time against declared permissions.

---

## Event Bus Contract

### Subscribe

Plugins declare events in `events[]`. They may only receive events matching their declared patterns.

### Publish

Plugins may publish events via `tg.publish(event, payload)` where:
- `event` must match a declared pattern or TG will reject it
- `payload` is audited (sensitive fields redacted)

### Contract Rules

1. **Governed**: All publish/subscribe passes through TG event broker.
2. **Audit**: Every event publish is recorded in audit chain.
3. **No Cross-Plugin Access**: Plugins cannot subscribe to other plugins' private events without explicit declaration.

---

## Sandbox Requirements

### Jailed Dispatcher

Code declared as `sandbox: "jailed"` runs in the TG jail:

- **No Direct Filesystem**: All file access via TG tools
- **No Direct Network**: All network via TG tools
- **Tool-Only Execution**: Actions must go through declared tools
- **No Secrets**: Access to secrets only via TG secret broker (value-length only in views)

### Browser-Side

Any UI rendering that requires browser execution:
- Must use declared view primitives
- Cannot access TG internal APIs
- Must declare actions for TG approval

---

## Fail-Closed Policy

When in doubt, TG fails closed:
- Invalid manifest → reject install
- Undeclared permission → deny action
- Missing approval → block consequential action
- Corrupt state → refuse to load (fail closed)

---

## Versioning

- Contract Version: 0.1
- Schema: JSON (strict validation)
- Migration: No automatic migration between versions. Version mismatch → installation rejected.
