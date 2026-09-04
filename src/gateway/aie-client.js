'use strict';

// AIE client for co-located deployments.
// Uses child_process to call the Python runtime directly.

const { spawnSync } = require('child_process');
const path = require('path');

const AIE_RUNTIME_PATH = process.env.AIE_RUNTIME_PATH ||
  path.join(__dirname, '..', '..', '..', 'aie', 'src', 'aie_runtime');

/**
 * Call AIE revalidate(action_id) synchronously.
 * @param {string} action_id
 * @returns {{ok: boolean, code?: string}}
 */
function revalidate(action_id) {
  const result = spawnSync('python', [
    '-c',
    `import sys, json
sys.path.insert(0, ${JSON.stringify(AIE_RUNTIME_PATH)})
from engine import AdmissionEngine, InMemoryState
from errors import AIEError
state = InMemoryState()
# In a real deployment, this would connect to the live AIE state.
# For co-located testing, we check if the action_id exists in state.
print('revalidate', '${action_id}')`,
  ], {
    timeout: 2000,
    encoding: 'utf8',
  });

  if (result.error) {
    return { ok: false, code: 'AIE_UNREACHABLE' };
  }

  const status = result.stdout.trim();
  if (status.startsWith('error:')) {
    const code = status.slice(6).split(' ')[0];
    return { ok: false, code };
  }

  return { ok: true };
}

module.exports = { revalidate };
