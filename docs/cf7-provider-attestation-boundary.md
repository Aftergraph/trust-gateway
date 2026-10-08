# CF7 provider-origin observation attestation (bounded precursor)

## Purpose and ownership

This Trust Gateway module is an **internal, read-only signing seam** for
`lume.cf7-provider-observation/1`. It may attest a **previously performed**
provider effect after authenticated remote readback. It may not start effects,
grant execution capability, change canonical Work/Run/WorkUnit state, or
produce an independent G29 outcome-verification verdict.

Only the Genesis/Lume canonical store owns execution intents, lease generation,
authority snapshots, receipts and canonical run events. The Cloudflare Workflow
is a durable placement, not a second ledger or authority plane.

## Trust constraints

- Backend-created adapters only: `loadIntent`, `verifyFence`,
  `checkAuthority`, `readProviderObservation`, and `signDetached` **must
  never** be supplied by the Workflow payload, a plugin, an agent or an HTTP
  request. Keep this module off public routing.
- `loadIntent` must read the actual canonical intent from its authoritative
  backend by operation ID and report `reconciliation_required`. Supplied
  WorkUnit strings do not create intent authority.
- `verifyFence` and `checkAuthority` must use fresh authoritative state and
  repeat **after** all provider readback I/O.
- `readProviderObservation` must authenticate Cloudflare/provider origin and
  prove the exact operation and external reference. An ordinary application
  “success” string, arbitrary Worker output, or mock is not production proof.
  It must return a uniquely referenced digest of the independently observed
  world state and a recent authoritative observation timestamp.
- `signDetached` must use a Trust Gateway-owned signing key or KMS/HSM
  handle. Never expose the private key to Lume, a Workflow, a plugin, the
  browser, test artifacts or GitHub logs.
- Keys should have scoped CF7 use, version IDs and a trust-root rotation path.
  Lume's public verifier must source allowed public keys from operator-managed
  trust configuration, never from evidence submitted by a caller.

## Output and verification

The issued envelope binds provider identity, intent/operation, tenant, Space,
Work/Run/WorkUnit/step/session/generation, action and arguments digests,
authority/policy refs, external reference, independent readback identity
and world-state digest, freshness window and a detached Ed25519 signature.

The Lume receipt writer verifies this exact signed snapshot and persists
receipt, intent CAS transition and canonical event atomically (subject to
landing of the related writer hardening). The receipt remains
`verified:false` and `canExecute:false`.

Independent #834 Verification must then re-check required completion criteria
using external/world-state evidence. **A signed observation is not itself
the final application-domain verdict.**

## Release state

This first module has isolated tests with a test-only Ed25519 key, a mock
authenticated provider readback and mock canonical authority. It is not wired
to a production provider adapter, public endpoint or long-lived signing key.
No consequential execution or 5/5 live verification is implied.
