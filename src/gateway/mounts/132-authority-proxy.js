'use strict';
// P2 mount: /v2/authority — AIE authority state surfaced through TG auth.
//
//   GET /v2/authority                   counts for all kinds
//   GET /v2/authority/:kind             items for kind (leases/missions/admissions/outcomes/evidence)
//
// Transport priority:
//   1. AIE_HTTP_URL set → fetch the AIE gateway HTTP read endpoints
//      (GET /leases, /missions, /admissions — AIE ab0c2b5). No subprocess,
//      no AIE_RUNTIME_PATH/AIE_PYTHON dependency. AIE_HTTP_TOKEN is the
//      bearer token the AIE gateway expects.
//   2. Otherwise → aie_authority_bridge.py subprocess (legacy, read-only,
//      fail-closed). Requires AIE_RUNTIME_PATH.
//
// Fail-closed in both modes: unreachable/config-missing → 502/503 with an
// error code — never synthetic data.

const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const KINDS = ['leases', 'missions', 'admissions', 'outcomes', 'evidence'];

// ponytail: HTTP kinds are the 3 endpoints the AIE gateway exposes (ab0c2b5);
// outcomes/evidence still route through the subprocess bridge until the
// gateway grows those endpoints.
const HTTP_KINDS = new Set(['leases', 'missions', 'admissions']);

function _cfg() {
  const runtimePath = process.env.AIE_RUNTIME_PATH ||
    path.join(__dirname, '..', '..', '..', '..', 'aie');  // mounts/gateway/src → repo → sibling
  return {
    httpUrl: process.env.AIE_HTTP_URL || '',
    httpToken: process.env.AIE_HTTP_TOKEN || '',
    bridge: path.join(runtimePath, 'scripts', 'aie_authority_bridge.py'),
    stateFile: process.env.AIE_STATE_FILE || path.join(process.cwd(), 'data', 'aie-state.db'),
    python: process.env.AIE_PYTHON || 'python',
  };
}

async function authorityReadHttp(kind) {
  const { httpUrl, httpToken } = _cfg();
  const url = `${httpUrl.replace(/\/$/, '')}/${kind}`;
  const headers = {};
  if (httpToken) headers.authorization = `Bearer ${httpToken}`;
  let resp;
  try {
    resp = await fetch(url, { headers, signal: AbortSignal.timeout(10_000) });
  } catch {
    return { ok: false, status: 502, error: 'aie_unreachable' };
  }
  if (resp.status === 401 || resp.status === 403) {
    return { ok: false, status: 502, error: 'aie_auth_failed' };
  }
  if (!resp.ok) {
    return { ok: false, status: 502, error: 'aie_error' };
  }
  const data = await resp.json().catch(() => null);
  if (!data) return { ok: false, status: 502, error: 'aie_error' };
  return { ok: true, data };
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

async function authorityReadAny(kind) {
  const { httpUrl, bridge } = _cfg();
  if (httpUrl && (!kind || HTTP_KINDS.has(kind))) {
    return authorityReadHttp(kind);
  }
  if (httpUrl && kind && !HTTP_KINDS.has(kind)) {
    // HTTP configured but gateway has no endpoint for this kind — fall back
    // to the subprocess bridge (which covers outcomes/evidence).
    return authorityRead(kind);
  }
  if (!fs.existsSync(bridge)) {
    return { ok: false, status: 503, error: 'authority_disabled' };
  }
  return authorityRead(kind);
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
    const result = await authorityReadAny(null);
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
    const result = await authorityReadAny(kind);
    res.statusCode = result.ok ? 200 : result.status;
    res.end(JSON.stringify(result.ok ? result.data : { error: result.error }));
  });
};

module.exports.KINDS = KINDS;
