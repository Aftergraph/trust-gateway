'use strict';

const crypto = require('node:crypto');

function fail(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

const ALLOWED_ROLES = new Set(['system', 'user', 'assistant']);

function validateDialagramRequest(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw fail('decision_provider_invalid_body');
  }

  const allowed = new Set(['model', 'messages', 'temperature']);
  if (Object.keys(body).some((key) => !allowed.has(key))) {
    throw fail('decision_provider_invalid_body');
  }

  const model = String(body.model || '').trim();
  if (!model || model.length > 160) throw fail('decision_provider_invalid_model');

  if (!Array.isArray(body.messages) || body.messages.length < 1 || body.messages.length > 64) {
    throw fail('decision_provider_invalid_messages');
  }

  const messages = body.messages.map((message) => {
    if (!message || typeof message !== 'object' || Array.isArray(message)) {
      throw fail('decision_provider_invalid_messages');
    }
    const keys = Object.keys(message);
    if (keys.some((key) => key !== 'role' && key !== 'content')) {
      throw fail('decision_provider_invalid_messages');
    }
    const role = String(message.role || '');
    if (!ALLOWED_ROLES.has(role) || typeof message.content !== 'string') {
      throw fail('decision_provider_invalid_messages');
    }
    if (Buffer.byteLength(message.content, 'utf8') > 128 * 1024) {
      throw fail('decision_provider_message_too_large');
    }
    return { role, content: message.content };
  });

  let temperature;
  if (body.temperature !== undefined) {
    temperature = Number(body.temperature);
    if (!Number.isFinite(temperature) || temperature < 0 || temperature > 2) {
      throw fail('decision_provider_invalid_temperature');
    }
  }

  return {
    model,
    messages,
    ...(temperature === undefined ? {} : { temperature }),
  };
}

function buildDialagramEgressRequest({
  body,
  tenantId,
  adapterId,
  credentialHandle,
  principalId,
  missionId,
  authorityRef,
  now = Date.now,
  randomUUID = crypto.randomUUID,
} = {}) {
  const providerBody = validateDialagramRequest(body);
  for (const [name, value] of Object.entries({
    tenantId,
    adapterId,
    credentialHandle,
    principalId,
    missionId,
    authorityRef,
  })) {
    if (typeof value !== 'string' || !value.trim()) {
      throw fail('decision_provider_' + name.replace(/[A-Z]/g, (c) => '_' + c.toLowerCase()) + '_required');
    }
  }

  const requestId = 'dpr_' + randomUUID();
  const resourceRef = 'adapter:' + adapterId;
  const payload = JSON.stringify(providerBody);
  const bodyDigest = 'sha256:' + crypto.createHash('sha256').update(payload).digest('hex');

  return {
    requestId,
    correlationId: requestId,
    executionContextId: 'decision-provider/dialagram',
    actionId: 'decision-provider/dialagram/chat-completions',
    effectId: requestId,
    effectClass: 'external_inference',
    tenantId,
    adapterId,
    principalId,
    missionId,
    authorityRef,
    purpose: 'decision_provider_inference',
    credentialHandle,
    destination: {
      scheme: 'https',
      host: 'dialagram.me',
      port: 443,
    },
    http: {
      method: 'POST',
      path: '/router/v1/chat/completions',
      query: {},
      headers: {
        'content-type': 'application/json',
      },
      body: payload,
      bodyDigest,
    },
    data: {
      sensitivity: ['internal'],
      provenanceRefs: [resourceRef],
      resourceRef,
      lineageId: requestId,
    },
    requestedAt: new Date(Number(now())).toISOString(),
  };
}

function publicProviderResult(result) {
  const status = Number(result?.status || 0);
  if (!Number.isInteger(status) || status < 100 || status > 599) {
    throw fail('decision_provider_invalid_upstream_status');
  }
  if (typeof result?.body !== 'string') {
    throw fail('decision_provider_invalid_upstream_body');
  }

  let body;
  try {
    body = result.body ? JSON.parse(result.body) : {};
  } catch {
    throw fail('decision_provider_invalid_upstream_json');
  }

  return { status, body };
}

module.exports = {
  validateDialagramRequest,
  buildDialagramEgressRequest,
  publicProviderResult,
};
