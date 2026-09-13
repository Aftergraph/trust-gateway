# Adapter production binding

This document defines the supported path for enabling adapter egress in the
Trust Gateway entrypoint.

## Activation

The runtime stays inert unless `TG_ADAPTER_RUNTIME=1`,
`TG_ADAPTER_GOVERNANCE_MODULE` points to a loadable Node module, and the
built-in stores have `TG_SECRETS_MASTER_KEY`. If activation is requested and
any condition is missing, `bin/gateway.js` refuses to start; it never falls
back to an ungoverned adapter path.

The governance module must export:

```js
module.exports = {
  createAdapterGovernance({ env, now, audit, aie }) {
    return {
      adapterContextResolver,
      authorityCheck,
      approvalCheck,
      credentialInjector,
      commitGuard,
      destinationPolicy,
    };
  },
};
```

The module is the authoritative Frontier Assurance/AIE integration. The
bootstrap passes `aie.revalidate` as a capability, but does not fabricate an
authority result from a bot role, bearer token, adapter registration, or
local policy classification.

Required boundaries:

- `adapterContextResolver(input)`: trusted principal, mission, authority,
  correlation and action binding for the adapter probe.
- `authorityCheck(request)`: live Frontier Assurance/AIE authority decision.
- `approvalCheck(request)`: current human approval and expiry.
- `credentialInjector({ secret, request })`: permitted credential header only.
- `commitGuard(input)`: atomic reservation immediately before transport commit,
  returning `{ ok: true, permitId }`.
- `destinationPolicy`: exact host/scheme/port/method/path rules.

## Invariants

- Custom production transports are rejected; the bootstrap always uses the
  Gateway pinned transport and address-pinning checks.
- Credentials use the tenant-scoped encrypted Vault and opaque,
  expiring, revocable handles.
- Broker decisions and failures flow through the Gateway audit function.
- Registered is not authorized, and transport possession is not execution
  authority.
- The activation flag is explicit; existing deployments remain inert until the
  reviewed policy module is deployed.

This binding contract does not claim AIES conformance by itself. The governance
module and its evidence must be reviewed before enabling the flag in production.
