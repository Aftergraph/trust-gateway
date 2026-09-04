'use strict';

// AIE client v2 — real execution-time revalidation (TH-12) against the AIE runtime.
//
// Calls aie_revalidate_bridge.py, which hydrates the real AdmissionEngine with
// PersistentState (leases survive restarts — W0.4 DoD) and revalidates the action
// against LIVE leases. Fail-closed: any bridge failure -> AIE_UNREACHABLE.
//
// Environment:
//   AIE_RUNTIME_PATH  path to the aie repo root (default ../../aie sibling checkout)
//   AIE_STATE_FILE    PersistentState sqlite db (default <cwd>/data/aie-state.db)
//   AIE_PYTHON        python interpreter (default 'python')
//   TG_AIE_FAIL_OPEN  'true' -> documented escape hatch (tests/dev only)

const { spawnSync } = require('child_process');
const path = require('path');
const { canonical, sha256 } = require('./hash-chain');

const AIE_RUNTIME_PATH = process.env.AIE_RUNTIME_PATH ||
  path.join(__dirname, '..', '..', '..', 'aie');
const AIE_STATE_FILE = process.env.AIE_STATE_FILE ||
  path.join(process.cwd(), 'data', 'aie-state.db');
const AIE_BRIDGE = path.join(AIE_RUNTIME_PATH, 'scripts', 'aie_revalidate_bridge.py');
const AIE_PYTHON = process.env.AIE_PYTHON || 'python';

// Admission producers must persist this digest in the tg-action:v1 extension.
// Reuse the gateway's canonical JSON so object-key order cannot change identity.
function actionFingerprint({ bot, tool, args = null }) {
  return sha256(canonical({ bot, tool, args: args ?? null }));
}

function revalidate(action_id, context = null) {
  if (typeof action_id !== 'string' || !action_id.trim()) {
    return { ok: false, code: 'AIE-AUTH-004' };
  }
  if (context !== null && (typeof context !== 'object' ||
      typeof context.bot !== 'string' || !context.bot ||
      typeof context.tool !== 'string' || !context.tool)) {
    return { ok: false, code: 'AIE-AUTH-004' };
  }
  const result = spawnSync(AIE_PYTHON, [
    AIE_BRIDGE,
    '--state', AIE_STATE_FILE,
    '--action-id', String(action_id),
    ...(context === null ? [] : ['--expected-binding', actionFingerprint(context)]),
  ], {
    timeout: 10000,
    encoding: 'utf8',
    windowsHide: true,
    maxBuffer: 64 * 1024,
  });

  if (result.error || result.status === null) {
    return { ok: false, code: 'AIE_UNREACHABLE' };
  }
  const out = (result.stdout || '').trim();
  try {
    const parsed = JSON.parse(out);
    if (result.status === 0 && parsed?.ok === true) return { ok: true };
    if (result.status === 1 && parsed?.ok === false &&
        typeof parsed.code === 'string' && /^AIE-[A-Z]+-\d{3}$/.test(parsed.code)) {
      return { ok: false, code: parsed.code };
    }
    return { ok: false, code: 'AIE_UNREACHABLE' };
  } catch {
    return { ok: false, code: 'AIE_UNREACHABLE' };
  }
}

module.exports = { revalidate, actionFingerprint, AIE_STATE_FILE, AIE_RUNTIME_PATH, AIE_BRIDGE };
