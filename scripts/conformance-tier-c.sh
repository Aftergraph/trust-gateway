#!/bin/bash
# Conformance tier-C — chaos/anti-fragility battery (FS-F5).
# Real spawned gateways, real kill -9, real ENOSPC tmpfs, real WAL races.
# Requires root for the tmpfs scenario (skipped honestly when unavailable).
cd "$(dirname "$0")/.." || exit 2
echo "=== CONFORMANCE TIER-C (chaos / anti-fragility) ==="
node --test tests/conformance/tier-c/chaos.test.js
