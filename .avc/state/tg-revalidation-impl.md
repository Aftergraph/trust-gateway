# TG → AIE Execution-Time Revalidation Implementation

**Status:** Implemented  
**Date:** 2026-09-04  
**Branch:** main (to be pushed to revalidate-wiring feature branch)

---

## Summary

Implemented execution-time revalidation wiring from Trust Gateway (TG) to AIE. This is the P0 gate that ensures the invariant:

> ADMISSION → time passes → EXECUTION-TIME REVALIDATION → side effect

Not "authorized at planning time, assume forever authorized".

---

## Changes Made

### 1. New AIE Client (`src/gateway/aie-client.js`)

- Synchronous Python runtime wrapper for co-located deployments
- Calls AIE's `revalidate(action_id)` function
- Returns `{ok: boolean, code?: string}` with error codes when failures occur
- Default 2-second timeout (fail-closed by default)

### 2. Server Integration (`src/gateway/server.js`)

Added revalidation hook in two execution paths:

#### Path 1: `_postAction` (direct action execution)

Located at line ~548, after budget check, before `_run()`:
- Calls `aie_revalidate()` with action_id
- On failure and fail-closed (default): returns appropriate HTTP status
- On failure and fail-open: logs audit entry, continues execution

#### Path 2: `_postApproval` (approved action execution)

Located at line ~622, mirrors `_postAction` path

---

## Error Code Mapping

| AIE Error Code          | HTTP Status | TG Error Response        |
|-------------------------|-------------|---------------------------|
| `AIE-AUTH-002`          | 410         | `lease_expired`           |
| `AIE-AUTH-003`          | 403         | `authority_revoked`       |
| `AIE-AUTH-004`          | 403         | `action_not_admitted`     |
| `AIE_UNREACHABLE`       | 502         | `aie_unreachable`         |
| Other                   | 403         | `revalidation_failed`     |

---

## Environment Variables

| Variable              | Default    | Description                                  |
|-----------------------|------------|----------------------------------------------|
| `TG_AIE_FAIL_OPEN`    | (unset)    | When `true`, bypass revalidation on AIE unreachable (debug/emergency only) |
| `AIE_RUNTIME_PATH`    | auto       | Path to AIE runtime (defaults to co-located) |

---

## Audit Trail

Every revalidation result is audited:

- `action.revalidation_failed` - records bot, tool, and error code
- `action_executed` - recorded after successful revalidation + execution
- `action_executed_after_approval` - for approved actions

---

## Fail-Closed Semantics

**Default (fail-closed):**
- AIE unreachable → 502, execution blocked
- Revalidation fails → appropriate 403/410, execution blocked

**Fail-open escape hatch (TG_AIE_FAIL_OPEN=true):**
- AIE unreachable → logs audit, continues execution
- NOT for production use

---

## Testing

Verify the revalidation hook is called:
1. After approval (for approved actions)
2. BEFORE actual side effect execution (`_run`)

---

## Files Modified

- `src/gateway/aie-client.js` (new)
- `src/gateway/server.js` (modified)

## Next Steps

1. Create feature branch: `git checkout -b revalidate-wiring`
2. Stage and commit: `git add . && git commit -m "feat: add TG→AIE execution-time revalidation"`
3. Push: `git push -u origin revalidate-wiring`
4. Create PR for review
