# Plugin Contract v0.2

## Status

Canonical implementation: `src/gateway/plugins.js` exposed by
`src/gateway/mounts/35-plugins.js`.

There is exactly one owner for the `/v2/plugins` surface. The former
`58-plugins.js` v0.1 mount was shadowed by `35-plugins.js` because object
mounts are filename-sorted and the gateway dispatches the first match. v0.2
converges the declarative v0.1 schema into the W4 hub rather than maintaining a
second registry.

## Purpose

A plugin package can declare its identity, intended capabilities, UI surfaces,
tools, events, automations, secrets and MCP endpoints without turning those
declarations into authority.

**Invariant:** manifest declarations never grant execution authority.
Consequential effects still require the Trust Gateway / AIE action-time
authority path.

## Manifest

```json
{
  "contractVersion": "0.2",
  "id": "plugin-id",
  "name": "Plugin Name",
  "version": "1.0.0",
  "entry": "index.js",
  "description": "Short description",
  "capabilities": ["plugin.read"],
  "permissions": ["read:*"],
  "tools": ["plugin.read"],
  "views": ["Card", "Table"],
  "events": ["plugin.changed"],
  "automations": [
    {"id": "sync", "trigger": "plugin.changed", "action": "plugin.read"}
  ],
  "sandbox": "jailed",
  "secrets": [{"name": "API_KEY", "required": true}],
  "mcp": [
    {"name": "plugin-mcp", "transport": "stdio", "command": "node", "args": ["mcp/index.js"]}
  ]
}
```

### Fields

| Field | Required | Contract |
|---|---:|---|
| `contractVersion` | No | `0.1` or `0.2`; omitted new installs normalize to `0.2` |
| `id` | Yes | lowercase slug, max 64 |
| `name` | Yes | 1–64 chars |
| `version` | Yes | semver |
| `entry` | Yes | relative `.js` file; traversal and symlinks refused |
| `description` | No | max 200 chars |
| `capabilities` | No | declared capability strings |
| `permissions` | No | declared permission strings; never grants |
| `tools` | No | declared tool identifiers/patterns |
| `views` | No | Card, Table, Form, Chart, Timeline, Approval, Progress, Artifact |
| `events` | No | declared event identifiers/patterns |
| `automations` | No | objects containing non-empty `trigger` + `action`; optional `id`, `condition` |
| `sandbox` | No | if supplied, must be `jailed`; normalized default is `jailed` |
| `secrets` | No | `{name, required?}` declarations |
| `mcp` | No | validated stdio/http/sse registry declarations |

Unknown manifest fields are rejected.

## Install integrity

New installs are immutable snapshots:

1. source root, manifest and entry must be real files/directories, not symlinks;
2. package traversal rejects symlinks, special files and configured size/count bounds;
3. a deterministic SHA-256 digest is computed over sorted relative paths, sizes and bytes;
4. the source is copied into a unique staging directory;
5. staging is re-hashed and must match the source digest;
6. the staged manifest is re-parsed and must normalize to the manifest that was admitted;
7. staging is renamed into `data/modules/<id>`;
8. the digest is persisted with plugin state and emitted on `plugin_installed`.

On enable, sealed packages are re-hashed. A mismatch fails closed with
`plugin_integrity_mismatch`.

Legacy installed records created before v0.2 remain readable and project
`integrity.sealed=false`; they do not gain a fabricated historical digest.
Reinstalling them under v0.2 creates a sealed snapshot.

## Enable preconditions

A plugin cannot be enabled while any manifest secret marked
`required: true` is unconfigured. The refusal is a 409
`required_secrets_missing` and is audited as `plugin_enable_refused`.

## Authority model

`permissions`, `capabilities`, `tools`, `events`, `automations` and
`views` are declarations. They are available to policy/UI consumers but are
not authorization tokens. No validator result can bypass TG/AIE policy,
approval, execution-context, credential-handle or governed-egress checks.

The W4 hub itself installs and governs package metadata; it does not execute a
plugin entry point merely because the package is enabled.

## HTTP surface

| Operation | Endpoint |
|---|---|
| List/install | `GET|POST /v2/plugins` |
| Inspect | `GET /v2/plugins/:id` |
| Enable/disable | `POST /v2/plugins/:id/enable|disable` |
| Uninstall | `DELETE /v2/plugins/:id` |
| Configure/remove declared secret | `PUT|DELETE /v2/plugins/:id/secrets/:name` |
| Skills | `GET /v2/skills` |
| MCP registry | `GET|POST /v2/mcp`, `DELETE /v2/mcp/:name` |

Writes are operator/approval-capability gated by the canonical mount.

## Secret posture

Plugin-secret API responses and audit payloads never return secret values.
The current W4 compatibility store still persists configured plugin secret
values inside mode-0600 `data/plugins.json`. v0.2 does **not** claim that
this legacy storage has been migrated to `SecretsVault` / scoped credential
handles; that migration requires an explicit tenant/binding design.

## Compatibility

Explicit v0.1 manifests are accepted as a strict compatibility input and are
normalized through the same canonical validator/runtime. No v0.1 route owner
remains.
