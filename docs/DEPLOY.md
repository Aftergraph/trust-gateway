# Trust Gateway Deploy

## Overview

This document covers deployment for the Trust Gateway (TG) project. Follow these steps to test, merge, and push to production.

## Test Tiers

Run tests using the tiered test runner:

```bash
# Tier A: Single test file (fast loop, seconds)
./test-tier.sh A tests/delegation-chain.test.js

# Tier B: Shard/domain tests (e.g. approvals, auth)
./test-tier.sh B A-auth-rbac-identity

# Tier C: Full suite (9 parallel shards, ~95s)
./test-tier.sh C
```

## Deploy Steps

### 1. Run Tier C Tests

Before any merge, run the full test suite to ensure nothing is broken:

```bash
./test-tier.sh C
```

Expected: All 9 shards return exit code 0. Telemetry logged to `.avc/state/test-telemetry.log`.

### 2. Merge PRs

PR #5 (store) and PR #6 (mount) are already merged to main. If adding new slices:

1. Ensure your branch passes Tier C locally
2. Open PR, request review
3. After approval, merge via squash-merge to main

### 3. Push to Production

The trust-gateway service runs on Fly.io. Deploy from a clean main:

```bash
# Verify you're on main and up to date
git checkout main
git pull origin main

# Run Tier C once more
./test-tier.sh C

# Deploy to Fly
flyctl deploy --image trust-gateway:latest
```

### 4. Verify Production

Check health and key routes:

```bash
# Health check
curl https://trust-gateway.fly.dev/healthz

# Delegation chain endpoint (for a known room)
curl https://trust-gateway.fly.dev/v2/rooms/:roomId/chain
```

## Rollback

If production deploys fail:

```bash
flyctl app rollback
```

Then investigate failing tests locally.

## Notes

- Tier C is ~95s with codex-shard isolation
- Telemetry logs to `.avc/state/test-telemetry.log`
- Secrets are vetted; no new dependencies added for delegation-chain slices
