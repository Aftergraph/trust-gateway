#!/bin/bash
# Wave-A smoke against the live gateway using the shared (gitignored) env file.
cd /root/agent-workforce
source data/gateway.env
export FORGE_TOKEN=$(echo "$TG_BOT_TOKENS" | sed -n 's/.*forge:\([^,]*\).*/\1/p')
export ATLAS_TOKEN=$(echo "$TG_BOT_TOKENS" | sed -n 's/.*atlas:\([^,]*\).*/\1/p')
export GATEWAY_URL=http://127.0.0.1:${TG_PORT:-8800}
node tests/wave-a.smoke.js
