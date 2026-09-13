'use strict';
const crypto = require('node:crypto');
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
// When an upstream identity exists, the client also derives a stable Work ID
// from the canonical payload and sends an idempotency key. Retries with the
// same identity and payload therefore converge on one Work; changed payloads
// use a different ID and are rejected by WORKS' idempotency gate.
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

// Work contract value, not an audit event type. Keep it named so the
// docs↔audit extractor does not confuse objective.type with {type: '...'} events.
const OBJECTIVE_CUSTOM = 'custom';

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
    type: OBJECTIVE_CUSTOM,
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

// Canonical JSON for identity derivation. Object keys are sorted and undefined
// fields are omitted, so equivalent payloads produce the same Work identity.
function stableJson(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return '[' + value.map(stableJson).join(',') + ']';
  if (value && typeof value === 'object') {
    return '{' + Object.keys(value)
      .filter((key) => value[key] !== undefined)
      .sort()
      .map((key) => JSON.stringify(key) + ':' + stableJson(value[key]))
      .join(',') + '}';
  }
  if (value === undefined) return 'null';
  return JSON.stringify(value);
}

function sha256(value) {
  return crypto.createHash('sha256').update(value, 'utf8').digest('hex');
}

function deriveWorkIdentity(correlationId, body) {
  if (typeof correlationId !== 'string' || correlationId.length === 0) return null;
  const payload = stableJson({
    correlation_id: correlationId,
    objective: body.objective,
    graph: body.graph,
    source: body.source,
    queue: body.queue,
  });
  return {
    id: 'wrk_' + sha256(payload).slice(0, 32),
    idempotency_key: 'tg_' + sha256(correlationId).slice(0, 32),
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
  const correlationId = spec.correlation_id || spec.mission_id || undefined;
  const body = {
    objective: normalizeObjective(spec.objective, spec.success_criteria),
    graph,
    correlation_id: correlationId,
    source: spec.source || undefined,
    queue: spec.queue !== false, // default: straight to QUEUED so workers can pick it up
  };
  const identity = deriveWorkIdentity(correlationId, body);
  if (identity) Object.assign(body, identity);

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

module.exports = {
  createWork,
  _cfg,
  normalizeObjective,
  defaultGraph,
  stableJson,
  deriveWorkIdentity,
};
