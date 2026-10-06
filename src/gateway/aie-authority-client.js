'use strict';

const AUTHORITY_ID = /^auth_[a-f0-9]{32}$/u;

class AIEAuthorityResolverError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

function cfgFromEnv(env = process.env) {
  const baseUrl = String(env.TG_AIE_HTTP_URL || '').replace(/\/+$/u, '');
  const token = String(env.TG_AIE_ADMIN_TOKEN || '');
  if (!/^https?:\/\//u.test(baseUrl) || !token) {
    throw new AIEAuthorityResolverError('AIE_AUTHORITY_UNCONFIGURED', 'AIE authority resolver is not configured');
  }
  return { baseUrl, token };
}

async function resolveAuthority(input, { env = process.env, fetchImpl = fetch } = {}) {
  const { baseUrl, token } = cfgFromEnv(env);
  let response;
  try {
    response = await fetchImpl(baseUrl + '/v1/authority/resolve', {
      method: 'POST',
      headers: {
        accept: 'application/json',
        'content-type': 'application/json',
        authorization: 'Bearer ' + token,
      },
      body: JSON.stringify({
        principal_id: input.principal_id,
        mission_id: input.mission_id,
        capability: input.capability,
        resource: input.resource,
      }),
    });
  } catch {
    throw new AIEAuthorityResolverError('AIE_AUTHORITY_UNAVAILABLE', 'AIE authority resolver unavailable');
  }
  let body;
  try { body = await response.json(); }
  catch { throw new AIEAuthorityResolverError('AIE_AUTHORITY_INVALID', 'AIE authority resolver returned invalid JSON'); }

  if (!response.ok) {
    const code = response.status === 404 ? 'AIE_AUTHORITY_NOT_FOUND' : 'AIE_AUTHORITY_UNAVAILABLE';
    throw new AIEAuthorityResolverError(code, 'AIE authority resolution failed');
  }
  if (
    body?.schema !== 'aie.authority-resolution/1.0' ||
    !AUTHORITY_ID.test(body.authority_lease_id || '') ||
    body.principal_id !== input.principal_id ||
    body.mission_id !== input.mission_id
  ) {
    throw new AIEAuthorityResolverError('AIE_AUTHORITY_INVALID', 'AIE authority resolution binding mismatch');
  }
  return body;
}


async function ensurePlatformAuthority(input, { env = process.env, fetchImpl = fetch } = {}) {
  const { baseUrl, token } = cfgFromEnv(env);
  let response;
  try {
    response = await fetchImpl(baseUrl + '/v1/platform-authority/ensure', {
      method: 'POST',
      headers: {
        accept: 'application/json',
        'content-type': 'application/json',
        authorization: 'Bearer ' + token,
      },
      body: JSON.stringify({
        principal_id: input.principal_id,
        tenant_id: input.tenant_id,
        identity_ref: input.identity_ref,
        idempotency_key: input.idempotency_key,
      }),
    });
  } catch {
    throw new AIEAuthorityResolverError('AIE_AUTHORITY_UNAVAILABLE', 'AIE platform authority unavailable');
  }
  let body;
  try { body = await response.json(); }
  catch { throw new AIEAuthorityResolverError('AIE_AUTHORITY_INVALID', 'AIE platform authority returned invalid JSON'); }
  if (!response.ok) {
    const code = response.status === 409 ? 'AIE_AUTHORITY_CONFLICT' : 'AIE_AUTHORITY_UNAVAILABLE';
    throw new AIEAuthorityResolverError(code, 'AIE platform authority ensure failed');
  }
  if (
    body?.schema !== 'aie.platform-authority/1.0' ||
    !AUTHORITY_ID.test(body.authority_lease_id || '') ||
    body.principal_id !== input.principal_id
  ) {
    throw new AIEAuthorityResolverError('AIE_AUTHORITY_INVALID', 'AIE platform authority binding mismatch');
  }
  return body;
}

module.exports = { resolveAuthority, ensurePlatformAuthority, AIEAuthorityResolverError, cfgFromEnv };
