'use strict';
// W0.3 — WORKS control-plane client (TG side of the mission chain).
//
// Creates a WORKS Work via POST /v1/works on the works-api control plane and
// returns the Work ID that becomes the MissionProposal's converted_to_mission_id.
//
// Environment:
//   WORKS_API_URL   base URL (default http://127.0.0.1:8080 — works-api default addr)
//   WORKS_API_TOKEN Bearer token for the /v1/works/* bearer gate (empty = unauth attempts,
//                   which fail closed server-side per AUTH.md)
//
// Fail-closed: if WORKS_API_URL is unset, createWork returns { ok:false, reason:'disabled' }
// instead of throwing — proposals still approve, but carry no WORKS correlation (they get
// the synthetic mission id from missions.js). Callers treat ok:false as "not durably executed".

// Read env at call time (not module load) so tests can point the client at mock
// control planes per test and production config changes apply without restart.
function _cfg() {
  return {
    url: process.env.WORKS_API_URL || '',
    token: process.env.WORKS_API_TOKEN || '',
  };
}

/**
 * Create a Work in the WORKS control plane.
 * @param {{objective: string, success_criteria?: string[], mission_id?: string, queue?: boolean}} spec
 * @returns {Promise<{ok: boolean, work_id?: string, reason?: string}>}
 */
async function createWork(spec) {
  const { url: baseUrl, token } = _cfg();
  if (!baseUrl) {
    return { ok: false, reason: 'disabled' }; // fail-closed: no WORKS control plane configured
  }
  const url = `${baseUrl.replace(/\/$/, '')}/v1/works`;
  const body = {
    objective: spec.objective,
    mission: spec.mission_id ? { id: spec.mission_id } : undefined,
    queue: spec.queue !== false, // default: straight to QUEUED so workers can pick it up
  };
  if (Array.isArray(spec.success_criteria) && spec.success_criteria.length) {
    body.success_criteria = spec.success_criteria;
  }
  const headers = { 'content-type': 'application/json' };
  if (token) headers.authorization = `Bearer ${token}`;

  let resp;
  try {
    resp = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10_000),
    });
  } catch (e) {
    return { ok: false, reason: `works_unreachable: ${e.message}` };
  }
  if (resp.status === 401 || resp.status === 403) {
    return { ok: false, reason: 'works_auth_failed' };
  }
  if (!resp.ok) {
    return { ok: false, reason: `works_error_${resp.status}` };
  }
  const data = await resp.json().catch(() => ({}));
  const workId = data.id || data.work && data.work.id;
  if (!workId) {
    return { ok: false, reason: 'works_missing_work_id' };
  }
  return { ok: true, work_id: workId };
}

module.exports = { createWork, _cfg };