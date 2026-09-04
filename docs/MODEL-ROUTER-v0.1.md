# Model Router v0.1

A minimal model router that selects models based on cost, capability, availability, and governance constraints.

## Routing Rules

### Cost Ceiling
- `budget_tier` controls maximum acceptable cost:
  - `free` — only free-tier models (marked `free: true` in catalog)
  - `economy` — free + lowest-cost paid models
  - `standard` — standard cost models (default)
  - `premium` — all models including premium/high-performance

### Capability Match
- `capability` string filters for models supporting the requested feature:
  - `code` — code generation/refactoring
  - `reasoning` — analytical/chain-of-thought tasks
  - `vision` — image understanding
  - `multimodal` — mixed media handling

### Provider Availability
- Primary selection uses `reg.plan()` heuristic (from providers.js)
- Falls back in order when primary fails or is unavailable

## Fallback Chain

1. **Primary**: Highest-ranked model matching constraints
2. **Secondary**: Next-ranked model from same provider tier
3. **Break-glass**: Any available AIE-approved model (no capability filter)

## Governance Constraints

- Only AIE-approved models in the provider catalog may be routed
- All routing decisions logged to audit chain
- No model keys or sensitive data exposed in responses
- Break-glass fallback only triggered when explicitly enabled

## API

### POST /v2/router/route

**Request:**
```json
{
  "capability": "code",
  "budget_tier": "economy"
}
```

**Response:**
```json
{
  "model": "glm-5.3-flash",
  "provider": "ollama-cloud",
  "fallbacks": [
    {"model": "minimax/minimax-m3:free", "provider": "openrouter"},
    {"model": "laguna-s-2.1-free", "provider": "opencode-zen"}
  ]
}
```

## Implementation Notes

- Minimal: 1 mount file, 1 doc file
- No new dependencies
- Leverages existing provider registry and plan() heuristic
- Advisory mode: does not block dispatch flow
