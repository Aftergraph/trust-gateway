# G18 · WORKS effect-time AIE revalidation

Companion to [Trust Gateway #173](https://github.com/Aftergraph/trust-gateway/pull/173) and [WORKS #239](https://github.com/Aftergraph/works-execution/pull/239).

The operator-protected POST /v2/works/effects/revalidate consumes an independently admitted `actionId`, not the accept-time dispatch action. It validates the exact immutable tuple (tenant, principal, mission, work, works execution, minted execution context, worker lease, authority lease, attempt, effect, idempotency key, effect digest and reservation amount). The existing persisted AIE bridge revalidates `actionId` with the exact fingerprint `works-runtime / execute_fenced_effect / args` and correlates its real authority lease. Unknown or asynchronous responses, revocation, expiry or unavailable AIE fail closed.

The result intentionally always sets canDispatchEffect:false. This endpoint is NOT a signed capability, admission producer, budget reservation, or permission to run a provider. A WORKS host still requires an active lease and authoritative budget hold in its own SQLite store. Fresh checks before external effects cannot make revocation and remote effect atomic by themselves. Provider-side idempotency and unknown-outcome reconciliation are mandatory before real effects can be enabled.

No production deployment, permission change, token issue, or automatic merge. Independent review, exact-head CI, operator credential provisioning through approved mechanism, and live sandbox proof remain open.
