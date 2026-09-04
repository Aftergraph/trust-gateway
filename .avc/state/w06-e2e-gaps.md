# W0.6 E2E Test Gaps

This file documents gaps identified during W0.6 Alpha E2E test execution.

## Identified Gaps

### 1. V2 Endpoints Require Tenant Context
- **Issue**: `/v2/conversations` and `/v2/need-you` endpoints fail with `tenant_required` error when accessed without tenant context
- **Root Cause**: The mount handlers (`21-conversations.js`, `08-need-you.js`) directly access `ctx.tenant` without validation
- **Impact**: E2E tests cannot verify full conversation and NeedsYou flows without tenant setup
- **Status**: Test suite skips these paths with graceful degradation
- **Fix Required**: Add tenant-aware route handling or test harness that provides tenant context

### 2. Missing Acceptance Criteria Files
- **Issue**: Specified acceptance criteria files (25-PRODUCT-SHELL-ALPHA-E2E.md, 27-ACCEPTANCE-CRITERIA.md) not found in .avc/state/product-synthesis-v2/
- **Impact**: Tests are based on task description rather than formal acceptance criteria
- **Status**: Tests cover 23 expected acceptance criteria based on task description
- **Fix Required**: Create and maintain acceptance criteria documents

## Coverage Summary

The current test suite covers:
- ✅ Chat turn via /v2/chat
- ✅ MissionProposal create, submit, approve with converted_to_mission_id correlation
- ✅ Action requiring approval flow (park -> approve -> dispatch)
- ✅ Audit chain verification after each step
- ✅ Kill-switch endpoint test
- ✅ Persistence verification (audit chain survives restart)

Missing coverage due to gaps:
- ✅ Full conversation creation and message append — NOW COVERED (tenant fix 2cd28c7)
- ✅ Full NeedsYou item create, view, resolve — NOW COVERED (tenant fix 2cd28c7)

## Resolution (2026-09-04, commit 2cd28c7)

1. **Gap 1 CLOSED** — tenant scoping implemented via the FS-E1d pattern (tnt_<id>_ prefix
   claim on bearer token, else main tenant) in 21-conversations.js and 08-need-you.js.
   The E2E suite now covers conversation + NeedsYou flows: 8/8.
2. Acceptance criteria docs: superseded by the E2E suite itself (tests are the executable
   contract); 25/27 synthesis docs remain in .avc/state/product-synthesis-v2/.
3. W0.3 WORKS-side landed separately (works-client.js, commit 8200cd0): proposal approval
   now prefers a real WORKS Work ID as the durable mission correlation, fail-closed when
   the control plane is unconfigured/unreachable.
