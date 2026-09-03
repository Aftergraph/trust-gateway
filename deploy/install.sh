#!/usr/bin/env bash
# deploy/install.sh — FS-E2 idempotent installer for the tg-gateway systemd unit.
#
# Installs deploy/tg-gateway.service into /etc/systemd/system/ (rewriting the
# WorkingDirectory to THIS repo's real path), runs `systemctl daemon-reload`
# and `systemctl enable --now tg-gateway`, waits up to 30s for /healthz to
# answer ok, then prints the service status.
#
# Safe to re-run: cp -f overwrites (never duplicates) the unit, enable is
# convergent, and the service is restarted ONLY if it is already active
# (`enable --now` handles the first start; restart just refreshes a live one).
#
# Secrets are never written here — the unit reads them at runtime from
# data/gateway.env via EnvironmentFile. This script must contain no tokens.
#
# DO NOT run while the gateway is served by a nohup process on the same port —
# systemd and nohup would fight over the listener. Stop the nohup process first.
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
UNIT_SRC="$REPO/deploy/tg-gateway.service"
UNIT_DST=/etc/systemd/system/tg-gateway.service
ENV_FILE="$REPO/data/gateway.env"
PORT="${PORT:-8800}"
BASE="http://127.0.0.1:${PORT}"

# ── preconditions (fail closed) ──
if [ ! -f "$UNIT_SRC" ]; then
  echo "install: unit template missing: $UNIT_SRC — refusing" >&2
  exit 1
fi
if [ ! -r "$ENV_FILE" ]; then
  echo "install: gateway env file unreadable: $ENV_FILE — refusing" >&2
  echo "  (create it with TG_BOT_TOKENS / TG_LLM_KEY; it is gitignored on purpose)" >&2
  exit 1
fi
if ! command -v node >/dev/null 2>&1; then
  echo "install: node is not installed / not on PATH — refusing" >&2
  exit 1
fi
if [ "$(id -u)" -ne 0 ]; then
  echo "install: needs root (system unit + /etc/systemd/system) — re-run with sudo" >&2
  exit 1
fi

# ── install the unit (idempotent: overwrite, never duplicate) ──
# Copy then rewrite every hardcoded /root/agent-workforce path
# (WorkingDirectory, EnvironmentFile, ReadWritePaths) to the repo this
# script actually lives in.
cp -f "$UNIT_SRC" "$UNIT_DST.tmp"
sed -i "s#/root/agent-workforce#$REPO#g" "$UNIT_DST.tmp"
if ! grep -q "^WorkingDirectory=$REPO\$" "$UNIT_DST.tmp"; then
  echo "install: WorkingDirectory rewrite failed — unit would run from the wrong dir" >&2
  rm -f "$UNIT_DST.tmp"
  exit 1
fi
mv -f "$UNIT_DST.tmp" "$UNIT_DST"

# ── reload + enable + (re)start ──
systemctl daemon-reload
systemctl enable tg-gateway.service >/dev/null 2>&1 || true
if [ "$(systemctl is-active tg-gateway.service 2>/dev/null || true)" = "active" ]; then
  systemctl restart tg-gateway.service   # pick up new unit/config on re-runs
else
  systemctl enable --now tg-gateway.service >/dev/null 2>&1 || systemctl start tg-gateway.service
fi

# ── health gate: /healthz must answer ok within 30s ──
healthy=0
for _ in $(seq 1 30); do
  body="$(curl -fsS --max-time 2 "$BASE/healthz" 2>/dev/null || true)"
  if [ -n "$body" ] && printf '%s' "$body" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>process.exit(JSON.parse(s).ok===true?0:1))' 2>/dev/null; then
    healthy=1
    break
  fi
  sleep 1
done
if [ "$healthy" -ne 1 ]; then
  echo "install: /healthz did not answer ok within 30s — FAILED" >&2
  echo "  logs: journalctl -u tg-gateway -n 50 --no-pager" >&2
  exit 1
fi
echo "install: tg-gateway.service is active and healthy on $BASE"
systemctl --no-pager --lines=5 status tg-gateway.service || true

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
