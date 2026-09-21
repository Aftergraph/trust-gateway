'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

const { open } = require('../src/gateway/db');
const { SecretsVault } = require('../src/gateway/secrets-vault');
const { CredentialHandleStore } = require('../src/gateway/credential-handles');
const { GovernedEgressBroker, requestDigest } = require('../src/gateway/governed-egress');
const {
  GovernedGitEgress,
  buildGitHubGitEgressRequest,
  classifyGitOperation,
} = require('../src/gateway/git-egress');

function fixture(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-git-egress-'));
  const db = open(path.join(dir, 'gateway.db'));
  const vault = new SecretsVault({ db, enabled: true, master: 'test-master-key-git-egress' });
  const cleanup = () => {
    try { db.close(); } catch {}
    fs.rmSync(dir, { recursive: true, force: true });
  };
  return Promise.resolve(fn({ db, vault })).finally(cleanup);
}

function input(overrides = {}) {
  return {
    operation: 'push',
    repository: 'Aftergraph/example',
    ref: 'refs/heads/p2-proof',
    newSha: 'a'.repeat(40),
    force: false,
    requestId: 'req_p2_1',
    correlationId: 'cor_p2_1',
    executionContextId: 'ctx_p2_1',
    actionId: 'act_p2_1',
    effectId: 'effect_p2_1',
    tenantId: 'main',
    principalId: 'principal/alice',
    missionId: 'mission/p2',
    authorityRef: 'authority/p2',
    credentialHandle: 'ch_placeholder',
    ...overrides,
  };
}

test('git operation classes distinguish read from consequential mutation', () => {
  assert.deepEqual(classifyGitOperation('fetch'), { operation: 'fetch', effectClass: 'git.read', mutating: false });
  assert.deepEqual(classifyGitOperation('push'), { operation: 'push', effectClass: 'git.mutate', mutating: true });
  assert.throws(() => classifyGitOperation('delete'), { code: 'git_operation_invalid' });
});

test('GitHub egress request binds repo/ref/context/action/effect and body digest', () => {
  const req = buildGitHubGitEgressRequest(input());
  assert.equal(req.http.method, 'PATCH');
  assert.equal(req.http.path, '/repos/Aftergraph/example/git/refs/heads/p2-proof');
  assert.equal(req.effectClass, 'git.mutate');
  assert.equal(req.executionContextId, 'ctx_p2_1');
  assert.equal(req.actionId, 'act_p2_1');
  assert.equal(req.effectId, 'effect_p2_1');
  assert.equal(req.data.resourceRef, 'repo:Aftergraph/example');
  assert.ok(req.data.provenanceRefs.includes('execution-context:ctx_p2_1'));
  assert.ok(req.data.provenanceRefs.includes('action:act_p2_1'));
  assert.ok(req.data.provenanceRefs.includes('effect:effect_p2_1'));
  assert.equal(
    req.http.bodyDigest,
    'sha256:' + crypto.createHash('sha256').update(req.http.body, 'utf8').digest('hex'),
  );
  assert.deepEqual(JSON.parse(req.http.body), { sha: 'a'.repeat(40), force: false });

  const read = buildGitHubGitEgressRequest(input({ operation: 'fetch', newSha: undefined }));
  assert.equal(read.http.method, 'GET');
  assert.equal(read.http.path, '/repos/Aftergraph/example/git/ref/heads/p2-proof');
  assert.equal(read.http.bodyDigest, null);
  assert.equal(read.effectClass, 'git.read');
});

test('invalid repository/ref/SHA and missing governance binding fail closed', () => {
  assert.throws(() => buildGitHubGitEgressRequest(input({ repository: '../evil' })), { code: 'git_repository_invalid' });
  assert.throws(() => buildGitHubGitEgressRequest(input({ ref: 'main' })), { code: 'git_ref_invalid' });
  assert.throws(() => buildGitHubGitEgressRequest(input({ newSha: 'abc' })), { code: 'git_sha_invalid' });
  assert.throws(() => buildGitHubGitEgressRequest(input({ executionContextId: '' })), { code: 'git_governance_binding_required' });
});

test('execution identity participates in egress digest', () => {
  const a = buildGitHubGitEgressRequest(input());
  const b = buildGitHubGitEgressRequest(input({ actionId: 'act_p2_2' }));
  const c = buildGitHubGitEgressRequest(input({ effectId: 'effect_p2_2' }));
  assert.notEqual(requestDigest(a), requestDigest(b));
  assert.notEqual(requestDigest(a), requestDigest(c));
});

test('scoped Git push passes broker only for current authority/handle and exact ref', async () => {
  await fixture(async ({ db, vault }) => {
    vault.setSecret('main', 'github-token', 'ghp_TEST_ONLY_SECRET');
    let now = 1_000;
    const store = new CredentialHandleStore({ db, vault, now: () => now });
    const handle = store.issue({
      tenant: 'main',
      secretKey: 'github-token',
      principalId: 'principal/alice',
      missionId: 'mission/p2',
      authorityRef: 'authority/p2',
      purpose: 'git_push',
      credentialClass: 'github_token',
      allowedDestinations: ['api.github.com'],
      allowedMethods: ['PATCH'],
      allowedPathPrefixes: ['/repos/Aftergraph/example/git/refs/heads/p2-proof'],
      scopeRefs: ['repo:Aftergraph/example', 'ref:refs/heads/p2-proof'],
      expiresAt: 2_000,
    });

    const audits = [];
    const transports = [];
    let authorityActive = true;
    const broker = new GovernedEgressBroker({
      handleStore: store,
      now: () => now,
      lookup: async () => [{ address: '140.82.121.5', family: 4 }],
      authorityCheck: async (req) => authorityActive && req.executionContextId === 'ctx_p2_1'
        ? { ok: true, version: 'auth-v1' }
        : { ok: false, reason: 'revoked' },
      approvalCheck: async () => ({ ok: true, expiresAt: 2_000 }),
      destinationPolicy: [{
        host: 'api.github.com',
        schemes: ['https'],
        ports: [443],
        methods: ['PATCH'],
        pathPrefixes: ['/repos/Aftergraph/example/git/refs/heads/p2-proof'],
      }],
      audit: (event) => audits.push(event),
      commitGuard: async ({ request }) => request.actionId === 'act_p2_1'
        ? { ok: true, permitId: 'permit/p2/1' }
        : { ok: false },
      credentialInjector: ({ secret, request }) => ({
        ...request,
        http: {
          ...request.http,
          headers: { ...request.http.headers, authorization: 'Bearer ' + secret },
        },
      }),
      transport: async (req, context) => {
        transports.push({ req, context });
        return { status: 200, headers: {}, body: '{"ref":"refs/heads/p2-proof"}', connectedAddress: '140.82.121.5' };
      },
    });

    const git = new GovernedGitEgress({ broker, audit: (event) => audits.push(event) });
    const result = await git.execute(input({ credentialHandle: handle.handleId }));
    assert.equal(result.result.status, 200);
    assert.equal(transports.length, 1);
    assert.equal(transports[0].req.http.headers.authorization, 'Bearer ghp_TEST_ONLY_SECRET');
    assert.equal(transports[0].context.permitId, 'permit/p2/1');

    const admitted = audits.find((event) => event.type === 'egress_admitted');
    assert.equal(admitted.executionContextId, 'ctx_p2_1');
    assert.equal(admitted.actionId, 'act_p2_1');
    assert.equal(admitted.effectId, 'effect_p2_1');
    assert.equal(admitted.effectClass, 'git.mutate');

    assert.ok(!JSON.stringify(audits).includes('ghp_TEST_ONLY_SECRET'));

    store.revoke(handle.handleId, 'revoked_for_test');
    await assert.rejects(
      () => git.execute(input({ credentialHandle: handle.handleId, requestId: 'req_p2_2' })),
      { code: 'credential_handle_revoked' },
    );
    assert.equal(transports.length, 1);

    const handle2 = store.issue({
      tenant: 'main',
      secretKey: 'github-token',
      principalId: 'principal/alice',
      missionId: 'mission/p2',
      authorityRef: 'authority/p2',
      purpose: 'git_push',
      credentialClass: 'github_token',
      allowedDestinations: ['api.github.com'],
      allowedMethods: ['PATCH'],
      allowedPathPrefixes: ['/repos/Aftergraph/example/git/refs/heads/p2-proof'],
      scopeRefs: ['repo:Aftergraph/example', 'ref:refs/heads/p2-proof'],
      expiresAt: 2_000,
    });

    await assert.rejects(
      () => git.execute(input({
        credentialHandle: handle2.handleId,
        ref: 'refs/heads/not-approved',
        requestId: 'req_p2_3',
      })),
      /destination_unknown|credential_handle_scope_mismatch/,
    );
    assert.equal(transports.length, 1);

    authorityActive = false;
    await assert.rejects(
      () => git.execute(input({ credentialHandle: handle2.handleId, requestId: 'req_p2_4' })),
      { code: 'authority_revoked' },
    );
    assert.equal(transports.length, 1);
  });
});
