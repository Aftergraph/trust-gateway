#!/bin/bash
# Conformance tier-A — the runnable the operators invoke.
# Spawns one gateway, runs all 9 domain smoke files, prints the matrix.
# Exit 0 only if every domain passes (gate for phase promotion, §20).
#
# FS-D1: worktree-portable. Resolves the repo root from the script's own
# location (the old hardcoded /root/agent-workforce broke worktree runs),
# sources data/gateway.env only when present, and honors a pre-set
# GATEWAY_URL — set it to target a spawned instance on a random port
# (tests/conformance/run.js reads the same variable; when the URL is
# already healthy it reuses that gateway instead of spawning one).
cd "$(dirname "$0")/.." || exit 2
if [ -f data/gateway.env ]; then source data/gateway.env; fi
export FORGE_TOKEN="${FORGE_TOKEN:-$(echo "$TG_BOT_TOKENS" | sed -n 's/.*forge:\([^,]*\).*/\1/p')}"
export ATLAS_TOKEN="${ATLAS_TOKEN:-$(echo "$TG_BOT_TOKENS" | sed -n 's/.*atlas:\([^,]*\).*/\1/p')}"
export GATEWAY_URL="${GATEWAY_URL:-http://127.0.0.1:${TG_PORT:-8800}}"
echo "=== CONFORMANCE TIER-A (§20.2) ==="
echo "gateway: $GATEWAY_URL"
node tests/conformance/run.js
