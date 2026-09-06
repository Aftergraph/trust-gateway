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

# ── pre-push remote guard (§20) — PR-fejlen opstod da origin pegede på
# JonasAbde-forken. Kanonisk upstream låses her; fork-remote → abort. ──
CANONICAL_REMOTE="https://github.com/Aftergraph/trust-gateway.git"
REMOTE_URL="$(git remote get-url origin 2>/dev/null || true)"
if [ "$REMOTE_URL" != "$CANONICAL_REMOTE" ]; then
  echo "rollout: origin er ikke kanonisk upstream ($REMOTE_URL)" >&2
  echo "rollout: forventet $CANONICAL_REMOTE — ret først: git remote set-url origin $CANONICAL_REMOTE" >&2
  exit 1
fi
git config branch.main.pushRemote origin >/dev/null 2>&1 || true

# ── pull (ff-only — a diverged VDS checkout must be resolved by hand) ──
PREV="$(git rev-parse HEAD)"
if ! git pull --ff-only; then
  echo "rollout: git pull --ff-only FAILED (diverged?)" >&2
  echo "  rollback hint: cd $REPO && git reset --hard $PREV" >&2
  exit 1
fi
echo "rollout: pulled $(git rev-parse --short HEAD) (was $PREV)"

# ── bump the PWA shell version to the deployed sha: the service worker is
#    cache-first, so WITHOUT a version bump every already-open console keeps
#    serving its old app.js/auth.js/panels forever (cache-first runtime cache
#    is keyed on VERSION). Injecting the sha makes each rollout a natural
#    cache invalidation. File is deployment-mutated only; next pull restores it.
#    Idempotent: matches ANY previously-injected sha too (a dirty checkout after
#    a failed earlier run must not make the bump a silent no-op).
SHA="$(git rev-parse --short HEAD)"
sed -i "s|const VERSION = 'trust-gateway-v2-pwa-[^']*'|const VERSION = 'trust-gateway-v2-pwa-${SHA}'|" app/sw.js
grep -q "trust-gateway-v2-pwa-${SHA}" app/sw.js || { echo "rollout: SW version bump FAILED" >&2; exit 1; }
echo "rollout: PWA shell version -> trust-gateway-v2-pwa-${SHA}"

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
