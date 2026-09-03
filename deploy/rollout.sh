#!/usr/bin/env bash
# deploy/rollout.sh — safe production rollout on the VDS.
#
# git pull --ff-only → smoke tests (standards + app) → restart → health gate.
# On ANY failure: nonzero exit + explicit rollback hint. Never force-pushes,
# never leaves the service down without telling the operator how to recover.
set -euo pipefail

REPO=/root/agent-workforce
PORT="${PORT:-8800}"
BASE="http://127.0.0.1:${PORT}"

cd "$REPO"

# ── pull (ff-only — a diverged VDS checkout must be resolved by hand) ──
PREV="$(git rev-parse HEAD)"
if ! git pull --ff-only; then
  echo "rollout: git pull --ff-only FAILED (diverged?)" >&2
  echo "  rollback hint: cd $REPO && git reset --hard $PREV" >&2
  exit 1
fi
echo "rollout: pulled $(git rev-parse --short HEAD) (was $PREV)"

# ── smoke tests BEFORE touching the running service ──
if ! node --test tests/standards.test.js tests/app.test.js; then
  echo "rollout: smoke tests FAILED — not restarting" >&2
  echo "  rollback hint: cd $REPO && git reset --hard $PREV" >&2
  exit 1
fi

# ── restart + health gate (10s) ──
systemctl restart tg-gateway.service
healthy=0
for _ in $(seq 1 10); do
  if curl -fsS --max-time 2 "$BASE/healthz" >/dev/null 2>&1; then
    healthy=1
    break
  fi
  sleep 1
done
if [ "$healthy" -ne 1 ]; then
  echo "rollout: /healthz did not answer within 10s after restart — FAILED" >&2
  echo "  logs: journalctl -u tg-gateway -n 50 --no-pager" >&2
  echo "  rollback hint: cd $REPO && git reset --hard $PREV && systemctl restart tg-gateway.service" >&2
  exit 1
fi

echo "rollout: OK — tg-gateway healthy at $BASE on $(git rev-parse --short HEAD)"
