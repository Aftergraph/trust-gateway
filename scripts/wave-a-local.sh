#!/bin/bash
shopt -s progcomp 2>/dev/null; exec 2>/dev/null
# Wave-A smoke against the live local gateway. Extracts bot tokens from the
# running gateway process env (no secrets stored in files or history).
cd /root/agent-workforce
ENV_LINE=''
for p in $(ls /proc | grep -E '^[0-9]+$'); do
  if tr '\0' '\n' < /proc/$p/environ 2>/dev/null | grep -q '^BOT_TOKENS='; then
    ENV_LINE=$(tr '\0' '\n' < /proc/$p/environ | grep '^BOT_TOKENS=' | cut -d= -f2-)
    break
  fi
done
if [ -z "$ENV_LINE" ]; then echo 'gateway not running (no BOT_TOKENS in env)' >&2; exit 2; fi
# BOT_TOKENS format: name:tok,name:tok
FORGE=$(echo "$ENV_LINE" | sed -n 's/.*forge:\([^,]*\).*/\1/p')
ATLAS=$(echo "$ENV_LINE" | sed -n 's/.*atlas:\([^,]*\).*/\1/p')
export FORGE_TOKEN="$FORGE"
export ATLAS_TOKEN="$ATLAS"
export GATEWAY_URL=http://127.0.0.1:8800
node tests/wave-a.smoke.js
