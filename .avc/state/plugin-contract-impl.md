# Plugin Contract v0.1 Implementation

## Status
- Implementation complete
- All tests passing (9/9)

## Files Created
1. `docs/PLUGIN-CONTRACT-v0.1.md` - Contract specification
2. `src/gateway/mounts/58-plugins.js` - Mount for plugin endpoints
3. `tests/plugins-contract.test.js` - Test suite

## Contract Summary
- Manifest schema defines: id, name, version, entry, permissions, tools, views, events, automations, sandbox
- Permission model: declared permissions are informational; TG/AIE policy enforces actual access
- UI primitives: Card, Table, Form, Chart, Timeline, Approval, Progress, Artifact
- Event bus: subscribe/publish governed by TG
- Sandbox: must be "jailed" - no direct filesystem/network access

## Endpoints
- GET /v2/plugins - List all plugins
- POST /v2/plugins/register - Register new plugin
- GET /v2/plugins/:id - View plugin details
- DELETE /v2/plugins/:id - Uninstall plugin

## Test Results
- validateManifest: accepts valid v0.1 manifest
- validateManifest: rejects invalid manifests
- permission model: declared permissions do not grant access
- permission model: TG/AIE policy enforces write operations
- UI declarations: only valid primitives allowed
- events: declaration allows subscription
- CRUD lifecycle: list, install, view, uninstall
- permission enforcement: worker cannot install, operator can
- fail-closed: invalid manifest rejected
