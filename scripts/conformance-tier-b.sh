#!/bin/bash
# Conformance tier-B — deep behavioral battery (FS-F2).
# Runs the tier-B test files against a REAL spawned gateway per test
# (tests/fs-helpers.js). Exit 0 only if every deep domain passes.
cd "$(dirname "$0")/.." || exit 2
echo "=== CONFORMANCE TIER-B (deep behavioral) ==="
node --test tests/conformance/tier-b/policy.test.js \
             tests/conformance/tier-b/secrets.test.js \
             tests/conformance/tier-b/ratelimits.test.js
