'use strict';
// P2 mount: /v2/authority — AIE authority state surfaced through TG auth.
//
//   GET /v2/authority                   counts for all kinds
//   GET /v2/authority/:kind             items for kind (leases/missions/admissions/outcomes/evidence)
//
// Calls aie_authority_bridge.py (read-only, fail-closed). If AIE is not
// configured (no AIE_RUNTIME_PATH), returns 503 authority_disabled — never
// synthetic data.
//
// ponytail: subprocess spawn per request; add caching only if the panel
// needs sub-second refresh at scale.

const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const KINDS = ['leases', 'missions', 'admissions', 'outcomes', 'evidence'];

function _cfg() {
  const runtimePath = process.env.AIE_RUNTIME_PATH ||
    path.join(__dirname, '..', '..', '..', '..', 'aie');  // mounts/gateway/src → repo → sibling
  return {
    bridge: path.join(runtimePath, 'scripts', 'aie_authority_bridge.py'),
    stateFile: process.env.AIE_STATE_FILE || path.join(process.cwd(), 'data', 'aie-state.db'),
    python: process.env.AIE_PYTHON || 'python',
  };
}

function authorityRead(kind) {
  const { bridge, stateFile, python } = _cfg();
  const args = [bridge, '--state', stateFile];
  if (kind) args.push('--kind', kind);
  const result = spawnSync(python, args, {
    timeout: 10000,
    encoding: 'utf8',
    windowsHide: true,
    maxBuffer: 1024 * 1024,
  });
  if (result.error || result.status === null) {
    return { ok: false, status: 502, error: 'aie_unreachable' };
  }
  try {
    const parsed = JSON.parse((result.stdout || '').trim().split('\n').pop());
    if (result.status === 0) return { ok: true, data: parsed };
    return { ok: false, status: 502, error: 'aie_error' };
  } catch {
    return { ok: false, status: 502, error: 'aie_unreachable' };
  }
}

module.exports = function mount(gw) {
  const operatorOnly = (req) => {
    const bot = req.bot;
    if (!bot) return false;
    return bot.role === 'operator' || bot.role === 'owner'
      || (Array.isArray(bot.capabilities) && (bot.capabilities.includes('*') || bot.capabilities.includes('authority.read')));
  };

  gw.router.get('/v2/authority', async (req, res) => {
    if (!operatorOnly(req)) {
      res.statusCode = 403;
      return res.end(JSON.stringify({ error: 'operator_required' }));
    }
    if (!fs.existsSync(_cfg().bridge)) {
      res.statusCode = 503;
      return res.end(JSON.stringify({ error: 'authority_disabled' }));
    }
    const result = authorityRead(null);
    res.statusCode = result.ok ? 200 : result.status;
    res.end(JSON.stringify(result.ok ? result.data : { error: result.error }));
  });

  gw.router.get('/v2/authority/:kind', async (req, res) => {
    if (!operatorOnly(req)) {
      res.statusCode = 403;
      return res.end(JSON.stringify({ error: 'operator_required' }));
    }
    const kindMatch = req.url.match(/^\/v2\/authority\/([^/]+)/);
    const kind = kindMatch ? decodeURIComponent(kindMatch[1]) : null;
    if (!kind || !KINDS.includes(kind)) {
      res.statusCode = 400;
      return res.end(JSON.stringify({ error: 'invalid_kind', valid: KINDS }));
    }
    if (!fs.existsSync(_cfg().bridge)) {
      res.statusCode = 503;
      return res.end(JSON.stringify({ error: 'authority_disabled' }));
    }
    const result = authorityRead(kind);
    res.statusCode = result.ok ? 200 : result.status;
    res.end(JSON.stringify(result.ok ? result.data : { error: result.error }));
  });
};

module.exports.KINDS = KINDS;
