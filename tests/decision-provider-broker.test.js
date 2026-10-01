'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { Readable } = require('node:stream');

const mount = require('../src/gateway/mounts/46-decision-providers');
const {
  buildDialagramEgressRequest,
  validateDialagramRequest,
} = require('../src/gateway/decision-provider-broker');

const ENV_KEYS = [
  'TG_DECISION_DIALAGRAM_BROKER',
  'TG_DECISION_DIALAGRAM_ADAPTER_ID',
  'TG_DECISION_DIALAGRAM_SECRET_NAME',
  'TG_DECISION_DIALAGRAM_PRINCIPAL_ID',
  'TG_DECISION_DIALAGRAM_MISSION_ID',
  'TG_DECISION_DIALAGRAM_AUTHORITY_REF',
  'TG_DECISION_DIALAGRAM_HANDLE_TTL_MS',
];

function withEnv(values, fn) {
  const previous = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
  for (const key of ENV_KEYS) delete process.env[key];
  Object.assign(process.env, values);
  return Promise.resolve()
    .then(fn)
    .finally(() => {
      for (const key of ENV_KEYS) {
        if (previous[key] === undefined) delete process.env[key];
        else process.env[key] = previous[key];
      }
    });
}

function request(body) {
  const req = Readable.from([Buffer.from(JSON.stringify(body))]);
  req.method = 'POST';
  req.headers = {};
  return req;
}

function response() {
  return {
    status: null,
    headers: null,
    body: '',
    writeHead(status, headers) {
      this.status = status;
      this.headers = headers;
    },
    end(body = '') {
      this.body = String(body);
    },
  };
}

const providerBody = () => ({
  model: 'qwen-3.8-max-thinking',
  temperature: 0,
  messages: [
    { role: 'system', content: 'Choose only from the declared option ids.' },
    { role: 'user', content: '{"options":["vds","lenovo"]}' },
  ],
});

test('Dialagram egress envelope is adapter-bound and body-digest pinned', () => {
  const request = buildDialagramEgressRequest({
    body: providerBody(),
    tenantId: 'main',
    adapterId: 'decision-dialagram',
    credentialHandle: 'ch_test',
    principalId: 'service:decision-runtime',
    missionId: 'service:decision-plane',
    authorityRef: 'authority:decision-provider-egress',
    now: () => 1_760_000_000_000,
    randomUUID: () => '00000000-0000-4000-8000-000000000001',
  });

  assert.equal(request.destination.host, 'dialagram.me');
  assert.equal(request.http.path, '/router/v1/chat/completions');
  assert.match(request.http.bodyDigest, /^sha256:[a-f0-9]{64}$/);
  assert.equal(request.data.resourceRef, 'adapter:decision-dialagram');
  assert.deepEqual(request.data.provenanceRefs, ['adapter:decision-dialagram']);
  assert.equal(request.credentialHandle, 'ch_test');
  assert.equal(request.purpose, 'decision_provider_inference');
  assert.equal(request.effectClass, 'external_inference');
  assert.ok(!request.http.headers.authorization);
});

test('provider input rejects undeclared fields and oversized message shape', () => {
  assert.throws(
    () => validateDialagramRequest({ ...providerBody(), apiKey: 'must-not-cross-boundary' }),
    /decision_provider_invalid_body/,
  );
  assert.throws(
    () => validateDialagramRequest({ ...providerBody(), messages: [] }),
    /decision_provider_invalid_messages/,
  );
});

test('broker route issues an ephemeral handle, dispatches governed egress, revokes it and never returns secret', async () => {
  await withEnv({
    TG_DECISION_DIALAGRAM_BROKER: '1',
    TG_DECISION_DIALAGRAM_ADAPTER_ID: 'decision-dialagram',
    TG_DECISION_DIALAGRAM_SECRET_NAME: 'api-key',
    TG_DECISION_DIALAGRAM_PRINCIPAL_ID: 'service:decision-runtime',
    TG_DECISION_DIALAGRAM_MISSION_ID: 'service:decision-plane',
    TG_DECISION_DIALAGRAM_AUTHORITY_REF: 'authority:decision-provider-egress',
    TG_DECISION_DIALAGRAM_HANDLE_TTL_MS: '60000',
  }, async () => {
    const calls = [];
    const audits = [];
    const secret = 'dialagram-secret-never-visible';
    const gw = {
      now: () => 1_760_000_000_000,
      _audit(event) { audits.push(event); },
      adapterCredentialLifecycle: {
        issueHandle(input) {
          calls.push(['issue', input]);
          return { handleId: 'ch_ephemeral_1', secret };
        },
        revokeHandle(input) {
          calls.push(['revoke', input]);
          return { handleId: input.handleId, revokedAt: 1_760_000_000_010 };
        },
      },
      governedEgressBroker: {
        requireAdapterBinding: true,
        async admit(egress) {
          calls.push(['admit', egress]);
          return { admissionId: 'ega_1', requestDigest: 'digest' };
        },
        async dispatch(admission, egress) {
          calls.push(['dispatch', admission, egress]);
          return {
            status: 200,
            connectedAddress: '203.0.113.20',
            headers: {},
            body: JSON.stringify({
              id: 'dialagram-request-1',
              model: 'qwen-3.8-max-thinking',
              choices: [{ message: { content: '{"answers":{}}' } }],
            }),
          };
        },
      },
    };

    const req = request(providerBody());
    const res = response();
    await mount.handle(gw, req, res, {
      bot: { name: 'decision-runtime', role: 'worker', capabilities: ['decision.provider.invoke'] },
      tenantId: 'main',
    });

    assert.equal(res.status, 200);
    const parsed = JSON.parse(res.body);
    assert.equal(parsed.id, 'dialagram-request-1');
    assert.equal(calls[0][0], 'issue');
    assert.equal(calls[0][1].secretName, 'api-key');
    assert.equal(calls[0][1].allowedDestinations[0], 'dialagram.me');
    assert.equal(calls[1][0], 'admit');
    assert.equal(calls[1][1].credentialHandle, 'ch_ephemeral_1');
    assert.equal(calls[2][0], 'dispatch');
    assert.equal(calls[3][0], 'revoke');
    assert.ok(audits.some((event) => event.type === 'decision_provider_brokered'));
    assert.ok(!JSON.stringify({ calls, audits, response: parsed }).includes(secret));
  });
});

test('broker route fails closed when disabled, unauthorized, or governance is absent', async () => {
  const baseGw = {
    now: () => Date.now(),
    _audit() {},
    adapterCredentialLifecycle: null,
    governedEgressBroker: null,
  };

  await withEnv({}, async () => {
    const res = response();
    await mount.handle(baseGw, request(providerBody()), res, {
      bot: { name: 'decision-runtime', role: 'worker', capabilities: ['decision.provider.invoke'] },
      tenantId: 'main',
    });
    assert.equal(res.status, 409);
    assert.deepEqual(JSON.parse(res.body), { error: 'decision_provider_broker_disabled' });
  });

  await withEnv({ TG_DECISION_DIALAGRAM_BROKER: '1' }, async () => {
    const res = response();
    await mount.handle(baseGw, request(providerBody()), res, {
      bot: { name: 'worker', role: 'worker', capabilities: [] },
      tenantId: 'main',
    });
    assert.equal(res.status, 403);
  });

  await withEnv({
    TG_DECISION_DIALAGRAM_BROKER: '1',
    TG_DECISION_DIALAGRAM_PRINCIPAL_ID: 'service:decision-runtime',
    TG_DECISION_DIALAGRAM_MISSION_ID: 'service:decision-plane',
    TG_DECISION_DIALAGRAM_AUTHORITY_REF: 'authority:decision-provider-egress',
  }, async () => {
    const res = response();
    await mount.handle(baseGw, request(providerBody()), res, {
      bot: { name: 'decision-runtime', role: 'worker', capabilities: ['decision.provider.invoke'] },
      tenantId: 'main',
    });
    assert.equal(res.status, 409);
    assert.deepEqual(JSON.parse(res.body), { error: 'governed_egress_required' });
  });
});
