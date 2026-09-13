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
// The WORKS API accepts the durable Work shape, not a chat-shaped shortcut:
// objective is an object, graph.nodes is non-empty, and correlation_id carries
// the upstream MissionProposal/workflow identity. A proposal without an
// execution graph receives a safe, read-only `true` node so the control-plane
// record is valid without inventing external side effects.
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

function normalizeObjective(objective, successCriteria) {
  const criteria = Array.isArray(successCriteria) && successCriteria.length
    ? successCriteria.slice()
    : null;
  if (objective && typeof objective === 'object' && !Array.isArray(objective)) {
    if (!criteria) return { ...objective };
    return {
      ...objective,
      constraints: {
        ...(objective.constraints || {}),
        success_criteria: criteria,
      },
    };
  }
  const out = {
    type: 'custom',
    description: typeof objective === 'string' ? objective : '',
  };
  if (criteria) out.constraints = { success_criteria: criteria };
  return out;
}

function defaultGraph() {
  return {
    nodes: {
      mission: {
        id: 'mission',
        // Safe admission fallback: no external side effects, no network.
        run: 'true',
      },
    },
  };
}

/**
 * Create a Work in the WORKS control plane.
 * @param {{
 *   objective: string|object,
 *   success_criteria?: string[],
 *   mission_id?: string,
 *   correlation_id?: string,
 *   graph?: object,
 *   source?: object,
 *   queue?: boolean
 * }} spec
 * @returns {Promise<{ok: boolean, work_id?: string, reason?: string}>}
 */
async function createWork(spec = {}) {
  const { url: baseUrl, token } = _cfg();
  if (!baseUrl) {
    return { ok: false, reason: 'disabled' }; // fail-closed: no WORKS control plane configured
  }
  const url = `${baseUrl.replace(/\/$/, '')}/v1/works`;
  const graph = spec.graph || defaultGraph();
  const body = {
    objective: normalizeObjective(spec.objective, spec.success_criteria),
    graph,
    correlation_id: spec.correlation_id || spec.mission_id || undefined,
    source: spec.source || undefined,
    queue: spec.queue !== false, // default: straight to QUEUED so workers can pick it up
  };

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

module.exports = { createWork, _cfg, normalizeObjective, defaultGraph };
