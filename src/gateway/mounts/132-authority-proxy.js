'use strict';
// P2 mount: /v2/authority — AIE authority state surfaced through TG auth.
//
//   GET  /v2/authority                   counts for all kinds
//   GET  /v2/authority/:kind             items for kind (leases/missions/admissions/outcomes/evidence)
//   POST /v2/authority/leases/:id/revoke revoke one lease (H6, operator-only)
//
// Transport priority:
//   1. AIE_HTTP_URL set → fetch the AIE gateway HTTP endpoints (ab0c2b5):
//      GET  /leases, /missions, /admissions
//      POST /revocations  (body {lease_id}) — the authoritative AIE revoke.
//      No subprocess, no AIE_RUNTIME_PATH/AIE_PYTHON dependency. AIE_HTTP_TOKEN
//      is the bearer token the AIE gateway expects.
//   2. Otherwise → aie_authority_bridge.py subprocess (legacy, read-only,
//      fail-closed). Requires AIE_RUNTIME_PATH.
//
// Fail-closed in both modes: unreachable/config-missing → 502/503 with an
// error code — never synthetic data. Revoke is HTTP-only: no bridge → 503.

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

// H6: find one lease in the authoritative AIE list. AIE GET /leases returns
// { leases: [...], count } — never invent a shape (user invariant: TG must
// not invent success locally).
async function authorityLease(leaseId) {
  const read = await authorityReadHttp('leases');
  if (!read.ok) return { ok: false, status: read.status, error: read.error };
  const list = read.data && Array.isArray(read.data.leases) ? read.data.leases : [];
  const lease = list.find((l) => String(l.id) === String(leaseId)) || null;
  return { ok: true, lease };
}

function leaseExpired(lease) {
  if (!lease || !lease.expires_at) return false;
  const exp = new Date(lease.expires_at);
  if (Number.isNaN(exp.getTime())) return false;
  return exp.getTime() < Date.now();
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

  // H6: POST /v2/authority/leases/:id/revoke — operatør revokerer en lease.
  // Full-stack mod AIE's autoritative kontrakt (ab0c2b5):
  //   pre-check  GET /leases  → lease findes? ikke allerede revoked? ikke expired?
  //   revoke     POST /revocations { lease_id }  (AIE er idempotent, INSERT OR IGNORE)
  //   read-back  GET /leases  → bekræft revoked===true (ellers 502, aldrig falsk success)
  //   audit-seal gw._audit()  → revocation er en sealed hash-chain begivenhed
  // Fail-closed: operator-check, reason-påkrævet, AIE-unreachable → ærlig fejl.
  gw.router.post('/v2/authority/leases/:id/revoke', async (req, res) => {
    if (!operatorOnly(req)) {
      res.statusCode = 403;
      return res.end(JSON.stringify({ error: 'operator_required' }));
    }
    const leaseMatch = req.url.match(/^\/v2\/authority\/leases\/([^/]+)\/revoke$/);
    if (!leaseMatch) {
      res.statusCode = 400;
      return res.end(JSON.stringify({ error: 'invalid_lease_id' }));
    }
    const leaseId = decodeURIComponent(leaseMatch[1]);

    // Læs reason fra body
    let body = '';
    for await (const chunk of req) body += chunk;
    let reason = '';
    try {
      const parsed = JSON.parse(body);
      reason = (parsed.reason || '').trim();
    } catch { /* empty body or invalid JSON */ }
    if (!reason) {
      res.statusCode = 400;
      return res.end(JSON.stringify({ error: 'reason_required' }));
    }

    const { httpUrl, httpToken } = _cfg();
    if (!httpUrl) {
      // Ingen AIE HTTP — kan ikke revoke (fail-closed, ikke fail-open)
      res.statusCode = 503;
      return res.end(JSON.stringify({ error: 'authority_disabled', detail: 'AIE_HTTP_URL not configured' }));
    }

    // Pre-check: lease skal findes, være active og ikke expired (fail-closed)
    const pre = await authorityLease(leaseId);
    if (!pre.ok) {
      res.statusCode = pre.status;
      return res.end(JSON.stringify({ error: pre.error }));
    }
    if (!pre.lease) {
      res.statusCode = 404;
      return res.end(JSON.stringify({ error: 'lease_not_found', lease_id: leaseId }));
    }
    if (pre.lease.revoked === true) {
      res.statusCode = 409;
      return res.end(JSON.stringify({ error: 'already_revoked', lease_id: leaseId }));
    }
    if (leaseExpired(pre.lease)) {
      res.statusCode = 409;
      return res.end(JSON.stringify({ error: 'lease_expired', lease_id: leaseId }));
    }

    // Revoke mod AIE's autoritative endpoint: POST /revocations { lease_id }
    const url = `${httpUrl.replace(/\/$/, '')}/revocations`;
    const headers = { 'content-type': 'application/json' };
    if (httpToken) headers.authorization = `Bearer ${httpToken}`;

    let resp;
    try {
      resp = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify({ lease_id: leaseId }),
        signal: AbortSignal.timeout(10_000),
      });
    } catch {
      res.statusCode = 502;
      return res.end(JSON.stringify({ error: 'aie_unreachable' }));
    }

    if (resp.status === 401 || resp.status === 403) {
      res.statusCode = 502;
      return res.end(JSON.stringify({ error: 'aie_auth_failed' }));
    }
    if (!resp.ok) {
      const errBody = await resp.text().catch(() => '');
      res.statusCode = 502;
      return res.end(JSON.stringify({ error: 'aie_error', status: resp.status, detail: errBody.slice(0, 200) }));
    }
    const revokeData = await resp.json().catch(() => ({}));

    // Read-back: bekræft fra AIE at lease faktisk er revoked. Uden bekræftelse
    // → 502, aldrig lokal opfundet succes (user invariant).
    const back = await authorityLease(leaseId);
    if (!back.ok || !back.lease || back.lease.revoked !== true) {
      res.statusCode = 502;
      return res.end(JSON.stringify({
        error: 'revoke_unconfirmed',
        lease_id: leaseId,
        detail: 'AIE besvarede revoke men read-back bekræfter ikke revoked=true',
      }));
    }

    // Governance: revocation er en sealed audit-begivenhed i hash-chain.
    // Write-ahead: beslutningen seal'es før vi svarer.
    if (typeof gw._audit === 'function') {
      try {
        gw._audit({
          type: 'authority_lease_revoke',
          lease_id: leaseId,
          reason,
          operator: req.bot ? req.bot.name : 'unknown',
          lease_readback_revoked: true,
        });
      } catch { /* audit-fejl må ikke dæmme op for selve revoke */ }
    }

    res.statusCode = 200;
    res.end(JSON.stringify({
      ...revokeData,
      ok: true,
      lease_id: leaseId,
      revoked: true,
      reason,
      lease: back.lease,
    }));
  });
};

module.exports.KINDS = KINDS;
