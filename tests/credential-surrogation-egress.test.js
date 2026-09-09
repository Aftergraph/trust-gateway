'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { open } = require('../src/gateway/db');
const { SecretsVault } = require('../src/gateway/secrets-vault');
const { CredentialHandleStore } = require('../src/gateway/credential-handles');
const { GovernedEgressBroker, requestDigest } = require('../src/gateway/governed-egress');

function fixture(name, fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `tg-egress-${name}-`));
  const db = open(path.join(dir, 'gateway.db'));
  const vault = new SecretsVault({ db, enabled: true, master: 'test-master-key-credential-broker' });
  const cleanup = () => {
    try { db.close(); } catch { /* already closed */ }
    fs.rmSync(dir, { recursive: true, force: true });
  };
  try {
    const result = fn({ db, vault });
    if (result && typeof result.then === 'function') return result.finally(cleanup);
    cleanup();
    return result;
  } catch (err) {
    cleanup();
    throw err;
  }
}

function issue(store, overrides = {}) {
  return store.issue({
    tenant: 'main',
    secretKey: 'github-token',
    principalId: 'principal/alice',
    missionId: 'mission/release-42',
    authorityRef: 'authority/release-publisher',
    purpose: 'publish_release',
    credentialClass: 'github_token',
    allowedDestinations: ['api.github.com'],
    allowedMethods: ['POST'],
    allowedPathPrefixes: ['/repos/Aftergraph/example/'],
    scopeRefs: ['repo:Aftergraph/example'],
    expiresAt: 2_000,
    ...overrides,
  });
}

function request(handleId, overrides = {}) {
  return {
    requestId: 'er_1',
    correlationId: 'corr_1',
    principalId: 'principal/alice',
    missionId: 'mission/release-42',
    authorityRef: 'authority/release-publisher',
    purpose: 'publish_release',
    credentialHandle: handleId,
    destination: { scheme: 'https', host: 'api.github.com', port: 443 },
    http: {
      method: 'POST',
      path: '/repos/Aftergraph/example/releases',
      query: { draft: 'false', z: '2', a: '1' },
      headers: { 'content-type': 'application/json', 'x-operation': 'release' },
      bodyDigest: 'sha256:body-1',
    },
    data: {
      sensitivity: ['internal'],
      provenanceRefs: ['evidence/source-1'],
      lineageId: 'lineage/1',
    },
    requestedAt: 1_000,
    ...overrides,
  };
}

function broker(store, opts = {}) {
  const audit = [];
  const transportCalls = [];
  const b = new GovernedEgressBroker({
    handleStore: store,
    now: opts.now || (() => 1_000),
    lookup: opts.lookup || (async () => [{ address: '140.82.121.5', family: 4 }]),
    authorityCheck: opts.authorityCheck || (async () => ({ ok: true, version: 'v1' })),
    approvalCheck: opts.approvalCheck || (async () => ({ ok: true, expiresAt: 2_000 })),
    destinationPolicy: opts.destinationPolicy || [
      {
        host: 'api.github.com',
        schemes: ['https'],
        ports: [443],
        methods: ['POST'],
        pathPrefixes: ['/repos/Aftergraph/example/'],
      },
    ],
    audit: (event) => audit.push(event),
    credentialInjector: ({ secret, request: req }) => ({
      ...req,
      http: {
        ...req.http,
        headers: { ...req.http.headers, authorization: `Bearer ${secret}` },
      },
    }),
    transport: async (req) => {
      transportCalls.push(req);
      if (opts.transport) return opts.transport(req);
      return { status: 201, headers: {}, body: { ok: true } };
    },
  });
  return { broker: b, audit, transportCalls };
}

test('credential handle is opaque, stored hashed, and never serializes the provider secret', () => {
  fixture('opaque', ({ db, vault }) => {
    vault.setSecret('main', 'github-token', 'ghp_REAL_PROVIDER_SECRET');
    const store = new CredentialHandleStore({ db, vault, now: () => 1_000, randomBytes: () => Buffer.alloc(32, 7) });
    const h = issue(store);

    assert.match(h.handleId, /^ch_[A-Za-z0-9_-]+$/);
    assert.ok(!JSON.stringify(h).includes('ghp_REAL_PROVIDER_SECRET'));

    const row = db.prepare('SELECT * FROM credential_handles').get();
    assert.ok(row);
    assert.equal(Object.prototype.hasOwnProperty.call(row, 'handle_id'), false);
    assert.ok(!JSON.stringify(row).includes(h.handleId));
    assert.ok(!JSON.stringify(row).includes('ghp_REAL_PROVIDER_SECRET'));

    const publicView = store.inspect(h.handleId);
    assert.equal(publicView.principalId, 'principal/alice');
    assert.equal(Object.prototype.hasOwnProperty.call(publicView, 'secret'), false);
  });
});

test('unknown, expired, revoked, foreign-principal and foreign-mission handles fail closed', () => {
  fixture('binding', ({ db, vault }) => {
    vault.setSecret('main', 'github-token', 'secret');
    let now = 1_000;
    const store = new CredentialHandleStore({ db, vault, now: () => now });
    const h = issue(store);

    assert.throws(() => store.resolveForBroker('ch_missing', request('ch_missing')), /credential_handle_unknown/);
    assert.throws(() => store.resolveForBroker(h.handleId, request(h.handleId, { principalId: 'principal/mallory' })), /credential_handle_principal_mismatch/);
    assert.throws(() => store.resolveForBroker(h.handleId, request(h.handleId, { missionId: 'mission/other' })), /credential_handle_mission_mismatch/);

    store.revoke(h.handleId, 'operator_revoked');
    assert.throws(() => store.resolveForBroker(h.handleId, request(h.handleId)), /credential_handle_revoked/);

    const h2 = issue(store, { expiresAt: 1_500 });
    now = 1_501;
    assert.throws(() => store.resolveForBroker(h2.handleId, request(h2.handleId)), /credential_handle_expired/);
  });
});

test('handle scope constrains destination, method and path', () => {
  fixture('scope', ({ db, vault }) => {
    vault.setSecret('main', 'github-token', 'secret');
    const store = new CredentialHandleStore({ db, vault, now: () => 1_000 });
    const h = issue(store);

    assert.throws(() => store.resolveForBroker(h.handleId, request(h.handleId, {
      destination: { scheme: 'https', host: 'evil.example', port: 443 },
    })), /credential_handle_scope_mismatch/);
    assert.throws(() => store.resolveForBroker(h.handleId, request(h.handleId, {
      http: { ...request(h.handleId).http, method: 'DELETE' },
    })), /credential_handle_scope_mismatch/);
    assert.throws(() => store.resolveForBroker(h.handleId, request(h.handleId, {
      http: { ...request(h.handleId).http, path: '/repos/Aftergraph/other/releases' },
    })), /credential_handle_scope_mismatch/);
  });
});

test('request digest commits query values and semantics-bearing caller headers canonically', () => {
  const a = request('ch_x');
  const b = request('ch_x');
  b.http.query = { a: '1', z: '2', draft: 'false' };
  b.http.headers = { 'x-operation': 'release', 'content-type': 'application/json' };
  assert.equal(requestDigest(a), requestDigest(b));

  const queryMutated = request('ch_x');
  queryMutated.http.query = { ...queryMutated.http.query, draft: 'true' };
  assert.notEqual(requestDigest(a), requestDigest(queryMutated));

  const headerMutated = request('ch_x');
  headerMutated.http.headers = { ...headerMutated.http.headers, 'x-operation': 'delete' };
  assert.notEqual(requestDigest(a), requestDigest(headerMutated));
});

test('unknown destination and private/link-local resolution fail closed before transport', async () => {
  await fixture('destination', async ({ db, vault }) => {
    vault.setSecret('main', 'github-token', 'secret');
    const store = new CredentialHandleStore({ db, vault, now: () => 1_000 });
    const h = issue(store);

    {
      const { broker: b, transportCalls } = broker(store);
      await assert.rejects(() => b.admit(request(h.handleId, {
        destination: { scheme: 'https', host: 'not-registered.example', port: 443 },
      })), /destination_unknown/);
      assert.equal(transportCalls.length, 0);
    }

    {
      const { broker: b, transportCalls } = broker(store, {
        lookup: async () => [{ address: '127.0.0.1', family: 4 }],
      });
      await assert.rejects(() => b.admit(request(h.handleId)), /destination_private_address/);
      assert.equal(transportCalls.length, 0);
    }
  });
});

test('mutating concrete request after admission invalidates the decision', async () => {
  await fixture('mutation', async ({ db, vault }) => {
    vault.setSecret('main', 'github-token', 'secret');
    const store = new CredentialHandleStore({ db, vault, now: () => 1_000 });
    const h = issue(store);
    const { broker: b, transportCalls } = broker(store);
    const original = request(h.handleId);
    const admission = await b.admit(original);

    const mutated = request(h.handleId);
    mutated.http.query = { ...mutated.http.query, draft: 'true' };
    await assert.rejects(() => b.dispatch(admission, mutated), /request_mutated_after_admission/);
    assert.equal(transportCalls.length, 0);
  });
});

test('revocation after planning but before transport commit blocks dispatch', async () => {
  await fixture('toctou', async ({ db, vault }) => {
    vault.setSecret('main', 'github-token', 'secret');
    const store = new CredentialHandleStore({ db, vault, now: () => 1_000 });
    const h = issue(store);
    let authorityActive = true;
    const { broker: b, transportCalls } = broker(store, {
      authorityCheck: async () => authorityActive ? { ok: true, version: 'v1' } : { ok: false, reason: 'revoked' },
    });
    const admission = await b.admit(request(h.handleId));

    const originalResolve = store.resolveForBroker.bind(store);
    store.resolveForBroker = (...args) => {
      const out = originalResolve(...args);
      authorityActive = false;
      return out;
    };

    await assert.rejects(() => b.dispatch(admission, request(h.handleId)), /authority_revoked/);
    assert.equal(transportCalls.length, 0);
  });
});

test('raw secret is injected only inside broker transport and never returned or audited', async () => {
  await fixture('secret-boundary', async ({ db, vault }) => {
    const secret = 'ghp_NEVER_MODEL_VISIBLE';
    vault.setSecret('main', 'github-token', secret);
    const store = new CredentialHandleStore({ db, vault, now: () => 1_000 });
    const h = issue(store);
    const { broker: b, audit, transportCalls } = broker(store);
    const admission = await b.admit(request(h.handleId));
    const result = await b.dispatch(admission, request(h.handleId));

    assert.deepEqual(result, { status: 201, headers: {}, body: { ok: true } });
    assert.equal(transportCalls.length, 1);
    assert.equal(transportCalls[0].http.headers.authorization, `Bearer ${secret}`);
    assert.ok(!JSON.stringify(admission).includes(secret));
    assert.ok(!JSON.stringify(result).includes(secret));
    assert.ok(!JSON.stringify(audit).includes(secret));
  });
});

test('redirect response is not followed; every redirected request requires re-admission', async () => {
  await fixture('redirect', async ({ db, vault }) => {
    vault.setSecret('main', 'github-token', 'secret');
    const store = new CredentialHandleStore({ db, vault, now: () => 1_000 });
    const h = issue(store);
    const { broker: b, transportCalls } = broker(store, {
      transport: async () => ({ status: 307, headers: { location: '/repos/Aftergraph/example/other' }, body: null }),
    });
    const admission = await b.admit(request(h.handleId));
    await assert.rejects(() => b.dispatch(admission, request(h.handleId)), /redirect_requires_readmission/);
    assert.equal(transportCalls.length, 1);
  });
});