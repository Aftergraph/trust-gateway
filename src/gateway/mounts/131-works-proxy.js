'use strict';
// P2 — WORKS proxy mount: /v2/executions.
//
// Surface the WORKS control plane (works-api) through TG auth so the SPA can
// show work status without ever talking to WORKS directly. Read-only v1:
//   GET /v2/executions            list recent works (limit ≤ 100)
//   GET /v2/executions/:workId    single work incl. graph/attempts/evidence
//
// Fail-closed: if WORKS_API_URL is unset or WORKS unreachable, endpoints
// return 503 works_disabled / 502 works_unreachable. No synthetic data.
//
// ponytail: direct proxy pass-through, no caching/normalization yet — the
// WORKS API is stable and the SPA only needs the raw shape. Add response
// shaping in a later slice if the panel needs a smaller projection.

const { send, readBody } = require('../server');

function _cfg() {
  return {
    base: process.env.WORKS_API_URL || '',
    token: process.env.WORKS_API_TOKEN || '',
  };
}

function worksFetch(path, { method = 'GET', body = null } = {}) {
  const { base: WORKS_BASE, token: WORKS_TOKEN } = _cfg();
  if (!WORKS_BASE) {
    return Promise.resolve({ ok: false, status: 503, reason: 'works_disabled' });
  }
  const headers = { 'content-type': 'application/json' };
  if (WORKS_TOKEN) headers.authorization = `Bearer ${WORKS_TOKEN}`;
  return fetch(`${WORKS_BASE.replace(/\/$/, '')}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(10_000),
  }).then(async (resp) => {
    const data = await resp.json().catch(() => ({}));
    return { ok: resp.ok, status: resp.status, data };
  }).catch((e) => ({ ok: false, status: 502, reason: `works_unreachable: ${e.message}` }));
}

module.exports = function mount(gw) {
  gw.router.get('/v2/executions', async (req, res) => {
    const result = await worksFetch('/v1/works?limit=100');
    if (!result.ok) {
      res.statusCode = result.status;
      return res.end(JSON.stringify({ error: result.reason || 'works_unreachable' }));
    }
    res.statusCode = 200;
    res.end(JSON.stringify({ works: result.data.works || [], count: result.data.count || 0 }));
  });

  gw.router.get('/v2/executions/:workId', async (req, res) => {
    const m = req.url.match(/^\/v2\/executions\/([^/]+)/);
    const workId = m ? decodeURIComponent(m[1]) : null;
    if (!workId) {
      res.statusCode = 400;
      return res.end(JSON.stringify({ error: 'missing_work_id' }));
    }
    const result = await worksFetch(`/v1/works/${encodeURIComponent(workId)}`);
    if (!result.ok) {
      res.statusCode = result.status === 404 ? 404 : result.status;
      return res.end(JSON.stringify({ error: result.status === 404 ? 'work_not_found' : (result.reason || 'works_unreachable') }));
    }
    res.statusCode = 200;
    res.end(JSON.stringify({ work: result.data.work || result.data }));
  });

  gw.router.get('/v2/executions/:workId/evidence', async (req, res) => {
    const m = req.url.match(/^\/v2\/executions\/([^/]+)\/evidence/);
    const workId = m ? decodeURIComponent(m[1]) : null;
    if (!workId) {
      res.statusCode = 400;
      return res.end(JSON.stringify({ error: 'missing_work_id' }));
    }
    const result = await worksFetch(`/v1/works/${encodeURIComponent(workId)}/evidence`);
    if (!result.ok) {
      res.statusCode = result.status === 404 ? 404 : result.status;
      return res.end(JSON.stringify({ error: result.status === 404 ? 'work_not_found' : (result.reason || 'works_unreachable') }));
    }
    // H1: videresend WORKS G5 verdicts (evidence_verdicts felt) til SPA/alarm-koden
    const response = { evidence: result.data.evidence || [] };
    if (result.data.evidence_verdicts) {
      response.evidence_verdicts = result.data.evidence_verdicts;
    }
    if (result.data.bundle_id) {
      response.bundle_id = result.data.bundle_id;
    }
    res.statusCode = 200;
    res.end(JSON.stringify(response));
  });
};
