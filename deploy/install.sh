#!/usr/bin/env bash
# deploy/install.sh — idempotent installer for the tg-gateway systemd unit.
#
# Safe to run repeatedly: copying the unit, daemon-reload, enable and restart
# are all convergent operations. Refuses to run when node is missing or the
# secrets env file is unreadable (fail closed, never start a broken gateway).
set -euo pipefail

REPO=/root/agent-workforce
UNIT_SRC="$REPO/deploy/tg-gateway.service"
UNIT_DST=/etc/systemd/system/tg-gateway.service
ENV_FILE="$REPO/data/gateway.env"
PORT="${PORT:-8800}"
BASE="http://127.0.0.1:${PORT}"

# ── preconditions (fail closed) ──
if ! command -v node >/dev/null 2>&1; then
  echo "install: node is not installed / not on PATH — refusing" >&2
  exit 1
fi
if [ ! -r "$ENV_FILE" ]; then
  echo "install: gateway env file unreadable: $ENV_FILE — refusing" >&2
  echo "  (create it with TG_BOT_TOKENS / TG_LLM_KEY; it is gitignored on purpose)" >&2
  exit 1
fi
if [ ! -f "$UNIT_SRC" ]; then
  echo "install: unit template missing: $UNIT_SRC — refusing" >&2
  exit 1
fi

# ── install (idempotent: copy + reload + enable + restart) ──
mkdir -p "$REPO/data"
cp -f "$UNIT_SRC" "$UNIT_DST"
systemctl daemon-reload
systemctl enable tg-gateway.service >/dev/null
systemctl restart tg-gateway.service

# ── health gate: /healthz must answer within 10s ──
healthy=0
for _ in $(seq 1 10); do
  if curl -fsS --max-time 2 "$BASE/healthz" >/dev/null 2>&1; then
    healthy=1
    break
  fi
  sleep 1
done
if [ "$healthy" -ne 1 ]; then
  echo "install: /healthz did not answer within 10s — FAILED" >&2
  echo "  logs: journalctl -u tg-gateway -n 50 --no-pager" >&2
  exit 1
fi
echo "install: tg-gateway is active and healthy on $BASE"

# ── print the tailscale URL (private tailnet route — never public) ──
if command -v tailscale >/dev/null 2>&1; then
  TS_DNS="$(tailscale status --json 2>/dev/null \
    | node -e 'let s="";process.stdin.on("data",(d)=>s+=d).on("end",()=>{try{const j=JSON.parse(s);console.log((j.Self&&j.Self.DNSName||"").replace(/\.$/,""))}catch{console.log("")}})')"
  if [ -n "$TS_DNS" ]; then
    echo "tailscale URL: https://${TS_DNS}/"
  else
    echo "tailscale URL: (unknown — run: tailscale serve --bg --https=443 $BASE)"
  fi
else
  echo "tailscale: not installed (see deploy/cloud.md §2)"
fi
