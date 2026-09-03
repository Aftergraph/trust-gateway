#!/bin/bash
# Conformance tier-A — the runnable the operators invoke.
# Spawns one gateway, runs all 9 domain smoke files, prints the matrix.
# Exit 0 only if every domain passes (gate for phase promotion, §20).
cd /root/agent-workforce
source data/gateway.env
export FORGE_TOKEN=$(echo "$TG_BOT_TOKENS" | sed -n 's/.*forge:\([^,]*\).*/\1/p')
export ATLAS_TOKEN=$(echo "$TG_BOT_TOKENS" | sed -n 's/.*atlas:\([^,]*\).*/\1/p')
export GATEWAY_URL=http://127.0.0.1:${TG_PORT:-8800}
echo "=== CONFORMANCE TIER-A (§20.2) ==="
echo "gateway: $GATEWAY_URL"
node tests/conformance/run.js