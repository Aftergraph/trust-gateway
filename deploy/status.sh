#!/usr/bin/env bash
# deploy/status.sh — one-shot operational status for the tg-gateway service.
#
# Prints: systemd is-active, /healthz body, /v1/audit/verify result,
# data/ disk usage, and the types of the last 5 audit-chain entries.
# Exits NONZERO if /healthz fails (the one hard gate); everything else
# is reported best-effort.
set -euo pipefail

REPO=/root/agent-workforce
ENV_FILE="$REPO/data/gateway.env"
AUDIT_FILE="$REPO/data/audit.jsonl"
PORT="${PORT:-8800}"
BASE="http://127.0.0.1:${PORT}"

if [ -r "$ENV_FILE" ]; then
  # shellcheck disable=SC1090  # env file holds secrets; sourced only, never printed
  . "$ENV_FILE"
  PORT="${PORT:-${TG_PORT:-8800}}"
  BASE="http://127.0.0.1:${PORT}"
fi

# ── systemd state ──
state="$(systemctl is-active tg-gateway.service 2>/dev/null || true)"
echo "service: ${state:-unknown}"

# ── healthz (HARD gate — nonzero exit on failure) ──
if ! curl -fsS --max-time 3 "$BASE/healthz"; then
  echo "" >&2
  echo "status: /healthz FAILED at $BASE" >&2
  exit 1
fi
echo ""

# ── audit chain verify (best-effort) ──
if ! curl -fsS --max-time 3 "$BASE/v1/audit/verify"; then
  echo "audit verify: request failed (gateway may still be starting)" >&2
else
  echo ""
fi

# ── data/ disk usage ──
if [ -d "$REPO/data" ]; then
  echo "data/ usage: $(du -sh "$REPO/data" | cut -f1)"
else
  echo "data/ usage: (no data directory)"
fi

# ── last 5 audit chain entry types ──
if [ -r "$AUDIT_FILE" ]; then
  echo "last 5 chain entries:"
  tail -n 5 "$AUDIT_FILE" | node -e '
    let s = ""; process.stdin.on("data", (d) => s += d).on("end", () => {
      for (const line of s.split("\n")) {
        if (!line.trim()) continue;
        try { console.log("  " + JSON.parse(line).payload.type); }
        catch { console.log("  <unparseable line>"); }
      }
    });'
else
  echo "last 5 chain entries: (no audit file at $AUDIT_FILE)"
fi
