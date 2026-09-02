#!/bin/bash
# Start the live gateway from the shared (gitignored) env file.
cd /root/agent-workforce
source data/gateway.env
exec env BOT_TOKENS="$TG_BOT_TOKENS" BOT_CAPS="$TG_BOT_CAPS" \
  BOT_ROLES="$TG_BOT_ROLES" PORT="$TG_PORT" \
  node bin/gateway.js --dispatch
