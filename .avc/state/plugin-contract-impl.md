# Plugin Contract implementation state

## Current status
- Canonical contract: **v0.2**
- Canonical runtime: `src/gateway/plugins.js` + `src/gateway/mounts/35-plugins.js`
- The former v0.1 `58-plugins.js` mount was removed after route-shadowing was proven.
- Declarative v0.1 manifests remain compatibility input to the v0.2 validator.
- v0.2 adds sealed package snapshots, enable-time integrity verification and required-secret preconditions.
- Verification source: `tests/plugins.test.js` + `tests/plugins-contract.test.js`; CI status is authoritative.

## Historical note
The previous state file reported “Implementation complete / 9/9” for v0.1.
That result was insufficient: HTTP tests could hit the earlier
`35-plugins.js` route while the later `58-plugins.js` owner remained
shadowed. Do not use the old 9/9 result as evidence of route ownership.

## Current contract
See `docs/PLUGIN-CONTRACT-v0.2.md`.
