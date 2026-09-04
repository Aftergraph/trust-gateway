# Trust Gateway Model Router v0.1 Implementation

## Summary

Implemented minimal Model Router v0.1 that routes requests to different models based on cost, capability, availability, and governance constraints.

## Files Created

- **docs/MODEL-ROUTER-v0.1.md** — Routing rules, fallback chain, and governance constraints
- **src/gateway/mounts/59-router.js** — POST /v2/router/route endpoint
- **tests/router.test.js** — Test coverage for routing functionality

## Implementation Details

### Routing Rules
- `budget_tier`: free, economy, standard, premium (controls cost ceiling)
- `capability`: code, reasoning, vision, multimodal (filters by model capability)
- Uses existing provider registry and plan() heuristic

### API
```
POST /v2/router/route
{ capability: string, budget_tier: string }
→ { model: string, provider: string, fallbacks: [...] }
```

### Governance
- Only AIE-approved models in the catalog can be routed
- All routing decisions logged to audit chain
- No sensitive data exposed in responses

## Verification

All tests pass:
- POST /v2/router/route: capability + budget_tier selection
- POST /v2/router/route: premium tier includes more options
- POST /v2/router/route: invalid JSON returns 400
- POST /v2/router/route: no auth returns 401
- POST /v2/router/route: empty body defaults work

## Commit

`030d52f` Add Model Router v0.1: routing endpoint + tests
