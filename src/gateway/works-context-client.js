'use strict';

const CTX_RE = /^ctx_[a-f0-9]{32}$/u;
const WORK_RE = /^wrk_[a-f0-9]{32}$/u;
const PDR_RE = /^pdr_[a-f0-9]{32}$/u;

function _cfg() {
  return {
    url: process.env.WORKS_API_URL || '',
    token: process.env.WORKS_API_TOKEN || '',
  };
}

function validContextShape(value) {
  return value &&
    value.schema === 'execution-context/1.0' &&
    typeof value.execution_context_id === 'string' &&
    CTX_RE.test(value.execution_context_id) &&
    typeof value.tenant_id === 'string' &&
    typeof value.principal_id === 'string' &&
    typeof value.mission_id === 'string' &&
    typeof value.authority_lease_id === 'string' &&
    typeof value.work_id === 'string' &&
    WORK_RE.test(value.work_id);
}

async function getExecutionContext(executionContextId, { fetchImpl = fetch } = {}) {
  if (typeof executionContextId !== 'string' || !CTX_RE.test(executionContextId)) {
    return { ok: false, reason: 'invalid_execution_context_id' };
  }
  const { url, token } = _cfg();
  if (!url) return { ok: false, reason: 'works_disabled' };

  const headers = { accept: 'application/json' };
  if (token) headers.authorization = `Bearer ${token}`;

  let resp;
  try {
    resp = await fetchImpl(
      `${url.replace(/\/$/, '')}/v1/execution-contexts/${encodeURIComponent(executionContextId)}`,
      { headers, signal: AbortSignal.timeout(10_000) },
    );
  } catch (e) {
    return { ok: false, reason: 'works_unreachable' };
  }
  if (resp.status === 401 || resp.status === 403) return { ok: false, reason: 'works_auth_failed' };
  if (resp.status === 404) return { ok: false, reason: 'execution_context_not_found' };
  if (!resp.ok) return { ok: false, reason: `works_error_${resp.status}` };

  const body = await resp.json().catch(() => null);
  if (!validContextShape(body) || body.execution_context_id !== executionContextId) {
    return { ok: false, reason: 'invalid_execution_context' };
  }
  return { ok: true, context: body };
}



async function recordExecutionPolicyDecision(
  { workId, executionContextId, executionPdrId },
  { fetchImpl = fetch } = {},
) {
  if (typeof workId !== 'string' || !WORK_RE.test(workId) ||
      typeof executionContextId !== 'string' || !CTX_RE.test(executionContextId) ||
      typeof executionPdrId !== 'string' || !PDR_RE.test(executionPdrId)) {
    return { ok: false, reason: 'invalid_platform_reference' };
  }
  const { url, token } = _cfg();
  if (!url) return { ok: false, reason: 'works_disabled' };

  const headers = { accept: 'application/json', 'content-type': 'application/json' };
  if (token) headers.authorization = `Bearer ${token}`;

  let resp;
  try {
    resp = await fetchImpl(
      `${url.replace(/\/$/, '')}/v1/works/${encodeURIComponent(workId)}/evidence`,
      {
        method: 'POST',
        headers,
        body: JSON.stringify({
          execution_context_id: executionContextId,
          execution_pdr_id: executionPdrId,
        }),
        signal: AbortSignal.timeout(10_000),
      },
    );
  } catch {
    return { ok: false, reason: 'works_unreachable' };
  }

  if (resp.status === 401 || resp.status === 403) return { ok: false, reason: 'works_auth_failed' };
  if (resp.status === 404) return { ok: false, reason: 'execution_context_not_found' };
  if (resp.status === 409) return { ok: false, reason: 'execution_pdr_conflict' };
  if (!resp.ok) return { ok: false, reason: `works_error_${resp.status}` };

  const body = await resp.json().catch(() => null);
  if (!body || (body.status !== 'recorded' && body.status !== 'already_recorded') ||
      body.execution_context_id !== executionContextId ||
      body.execution_pdr_id !== executionPdrId) {
    return { ok: false, reason: 'invalid_execution_pdr_receipt' };
  }
  return { ok: true, receipt: body };
}

module.exports = { getExecutionContext, recordExecutionPolicyDecision, validContextShape, _cfg };
