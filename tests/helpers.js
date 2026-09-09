'use strict';
// tests/helpers.js — shared test utilities.
//
// resolvePython(): interpreter for AIE sidecar tests. Prefers python3,
// falls back to bare python, always honoring AIE_PYTHON. Bare `python`
// does not exist on minimal images (node:22-alpine, GH ubuntu runners),
// so hard-coding it breaks AIE-boot tests environmentally.
const { execSync } = require('node:child_process');

function resolvePython() {
  if (process.env.AIE_PYTHON) return process.env.AIE_PYTHON;
  for (const candidate of ['python3', 'python']) {
    try {
      execSync(`${candidate} --version`, { stdio: 'ignore' });
      return candidate;
    } catch {
      // try next candidate
    }
  }
  return 'python3';
}

module.exports = { resolvePython };
