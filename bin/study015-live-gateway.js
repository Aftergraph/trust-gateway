#!/usr/bin/env node
'use strict';

// STUDY-015 L3 process adapter. This starts the real Gateway HTTP surface and
// wires one narrowly scoped governed git.push executor. It exists only on the
// research branch; production bin/gateway.js remains unchanged.

const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');

function required(name, min = 1) {
  const value = process.env[name] || '';
  if (Buffer.byteLength(value) < min) {
    throw new Error(`${name} must be configured (${min}+ bytes)`);
  }
  return value;
}

const workerToken = required('STUDY015_TG_WORKER_TOKEN', 16);
const operatorToken = required('STUDY015_TG_OPERATOR_TOKEN', 16);
const githubToken = required('STUDY015_GITHUB_TOKEN', 20);
const masterKey = required('TG_SECRETS_MASTER_KEY', 32);
const organizationId = required('STUDY015_ORGANIZATION_ID');
const tenantId = required('STUDY015_TENANT_ID');
const principalId = required('STUDY015_PRINCIPAL_ID');
const missionId = required('STUDY015_MISSION_ID');
const authorityRef = required('STUDY015_AUTHORITY_LEASE_ID');
const repository = required('STUDY015_GIT_REPOSITORY');
const ref = required('STUDY015_GIT_REF');
const readyOut = required('STUDY015_TG_READY_OUT');
const dataDir = required('TG_DATA_DIR');
const auditFile = path.join(dataDir, 'study015-audit.jsonl');
const port = Number(process.env.STUDY015_TG_PORT || 0);
const postTransportCrash = process.env.STUDY015_FAIL_AFTER_TRANSPORT_SUCCESS === '1';
const reconciliationFile = String(process.env.STUDY015_RECONCILIATION_FILE || '').trim();

if (!/^org_[a-f0-9]{32}$/.test(organizationId)) throw new Error('bad organization id');
if (!/^ten_[a-f0-9]{32}$/.test(tenantId)) throw new Error('bad tenant id');
if (!/^prn_[a-f0-9]{32}$/.test(principalId)) throw new Error('bad principal id');
if (!/^auth_[a-f0-9]{32}$/.test(authorityRef)) throw new Error('bad authority lease id');
if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) throw new Error('bad repository');
if (!/^refs\/heads\/[A-Za-z0-9._\/-]+$/.test(ref)) throw new Error('bad git ref');
if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('bad port');

process.env.TG_SECRETS_VAULT = '1';
process.env.TG_PLATFORM_ORG_ID = organizationId;

const dbmod = require('../src/gateway/db');
const { TenantStore } = require('../src/gateway/tenants');
const { SecretsVault } = require('../src/gateway/secrets-vault');
const { CredentialHandleStore } = require('../src/gateway/credential-handles');
const { createGovernedEgressBroker } = require('../src/gateway/governed-egress');
const { GovernedGitEgress } = require('../src/gateway/git-egress');
const { revalidate } = require('../src/gateway/aie-client');
const { createPinnedTransport } = require('../src/gateway/pinned-transport');
const { createPostTransportCrashTransport } = require('../research/study015/post-transport-crash');
const { validateStudy015ReconciliationRecord } = require('../research/study015/reconciliation-record');
const { Gateway } = require('../src/gateway/server');

const tenants = new TenantStore();
tenants.ensureMain();
const createdAt = new Date().toISOString();

dbmod.db.prepare(`
  INSERT OR IGNORE INTO platform_tenant_bindings
    (local_tenant_id, tenant_id, organization_id, created_at)
  VALUES ('main', ?, ?, ?)
`).run(tenantId, organizationId, createdAt);
const tenantBinding = dbmod.db.prepare(`
  SELECT tenant_id, organization_id FROM platform_tenant_bindings
  WHERE local_tenant_id='main'
`).get();
if (!tenantBinding || tenantBinding.tenant_id !== tenantId ||
    tenantBinding.organization_id !== organizationId) {
  throw new Error('platform tenant binding mismatch');
}

dbmod.db.prepare(`
  INSERT OR IGNORE INTO platform_principal_bindings
    (tenant_id, identity_ref, principal_id, principal_type, status, created_at)
  VALUES (?, 'bot:worker', ?, 'agent', 'active', ?)
`).run(tenantId, principalId, createdAt);
const principalBinding = dbmod.db.prepare(`
  SELECT principal_id, principal_type, status
  FROM platform_principal_bindings
  WHERE tenant_id=? AND identity_ref='bot:worker'
`).get(tenantId);
if (!principalBinding || principalBinding.principal_id !== principalId ||
    principalBinding.principal_type !== 'agent' || principalBinding.status !== 'active') {
  throw new Error('platform principal binding mismatch');
}

const vault = new SecretsVault({ db: dbmod.db, enabled: true, master: masterKey });
const secretKey = 'study015-github-token';
vault.setSecret('main', secretKey, githubToken);
const handles = new CredentialHandleStore({ db: dbmod.db, vault });
const pathPrefix = '/repos/' + repository + '/git/refs/heads/';
const handle = handles.issue({
  tenant: 'main',
  secretKey,
  principalId,
  missionId,
  authorityRef,
  purpose: 'git_push',
  credentialClass: 'github-token',
  allowedDestinations: ['api.github.com'],
  allowedMethods: ['PATCH'],
  allowedPathPrefixes: [pathPrefix],
  scopeRefs: ['repo:' + repository, 'platform-tenant:' + tenantId],
  expiresAt: Date.now() + 30 * 60 * 1000,
});

const gw = new Gateway({
  mountFiles: false,
  telemetryFile: null,
  auditFile,
  bots: {
    worker: { token: workerToken, role: 'worker', capabilities: [] },
    operator: { token: operatorToken, role: 'operator', capabilities: ['*'] },
  },
});

let reconciliationRecorded = false;
if (reconciliationFile) {
  const parsed = JSON.parse(fs.readFileSync(reconciliationFile, 'utf8'));
  const record = validateStudy015ReconciliationRecord(parsed, {
    executionContextId: parsed.execution_context_id,
    actionId: parsed.action_id,
    effectId: parsed.effect_id,
    correlationId: parsed.correlation_id,
    repository,
    ref,
    expectedSha: parsed.expected_sha,
  });
  gw._audit({
    type: 'git_egress_reconciled',
    requestId: record.request_id,
    correlationId: record.correlation_id,
    executionContextId: record.execution_context_id,
    actionId: record.action_id,
    effectId: record.effect_id,
    repository: record.repository,
    ref: record.ref,
    status: record.status,
    expectedSha: record.expected_sha,
    observedSha: record.observed_sha,
    observedVia: record.observed_via,
  });
  reconciliationRecorded = true;
}

function assertSame(actual, expected, code) {
  if (actual !== expected) {
    const err = new Error(code);
    err.code = code;
    throw err;
  }
}

gw.registerExecutor(/^git\.push$/, async (botName, tool, args, platformExecution) => {
  if (botName !== 'worker' || tool !== 'git.push') throw new Error('study015_executor_identity_mismatch');
  if (!platformExecution || !platformExecution.context || !platformExecution.pdr) {
    throw new Error('study015_platform_execution_missing');
  }
  if (!args || typeof args !== 'object') throw new Error('study015_args_missing');

  const context = platformExecution.context;
  assertSame(args.action_id, platformExecution.pdr.action_id, 'study015_action_binding_mismatch');
  assertSame(args.execution_context_id, context.execution_context_id, 'study015_context_binding_mismatch');
  assertSame(args.mission_id, context.mission_id, 'study015_mission_binding_mismatch');
  assertSame(args.authority_ref, context.authority_lease_id, 'study015_authority_binding_mismatch');
  assertSame(args.tenant_id, context.tenant_id, 'study015_tenant_binding_mismatch');
  assertSame(args.principal_id, context.principal_id, 'study015_principal_binding_mismatch');
  assertSame(args.repository, repository, 'study015_repository_mismatch');
  assertSame(args.ref, ref, 'study015_ref_mismatch');
  if (!/^effect\/[A-Za-z0-9._\/-]+$/.test(String(args.effect_id || ''))) {
    throw new Error('study015_effect_id_invalid');
  }
  if (!/^causal\/[A-Za-z0-9._\/-]+$/.test(String(args.causal_id || ''))) {
    throw new Error('study015_causal_id_invalid');
  }
  if (!/^[a-f0-9]{40}$/.test(String(args.new_sha || ''))) {
    throw new Error('study015_new_sha_invalid');
  }

  const expectedArgs = args;
  const approvalCheck = async (request) => {
    for (const row of gw.approvals.requests.values()) {
      if (row.status === 'approved' &&
          row.action_id === request.actionId &&
          row.bot === 'worker' &&
          row.tool === 'git.push') {
        return { ok: true, expiresAt: row.expiresAt };
      }
    }
    return { ok: false, reason: 'outer_tg_approval_not_found' };
  };

  const broker = createGovernedEgressBroker({
    handleStore: handles,
    destinationPolicy: [{
      host: 'api.github.com',
      schemes: ['https'],
      ports: [443],
      methods: ['PATCH'],
      pathPrefixes: [pathPrefix],
    }],
    authorityCheck: async (request) => {
      const rv = revalidate(request.actionId, {
        bot: 'worker',
        tool: 'git.push',
        args: expectedArgs,
      });
      return rv.ok === true
        ? { ok: true, version: request.actionId }
        : { ok: false, reason: rv.code || 'revalidation_failed' };
    },
    approvalCheck,
    audit: (event) => gw._audit(event),
    credentialInjector: ({ secret, request }) => ({
      ...request,
      http: {
        ...request.http,
        headers: {
          ...request.http.headers,
          authorization: 'Bearer ' + secret,
        },
      },
    }),
    commitGuard: async ({ request }) => {
      try {
        assertSame(request.executionContextId, context.execution_context_id, 'study015_commit_context_mismatch');
        assertSame(request.actionId, platformExecution.pdr.action_id, 'study015_commit_action_mismatch');
        assertSame(request.effectId, args.effect_id, 'study015_commit_effect_mismatch');
        assertSame(request.missionId, context.mission_id, 'study015_commit_mission_mismatch');
        assertSame(request.authorityRef, context.authority_lease_id, 'study015_commit_authority_mismatch');
        assertSame(request.tenantId, context.tenant_id, 'study015_commit_tenant_mismatch');
        assertSame(request.principalId, context.principal_id, 'study015_commit_principal_mismatch');
        return { ok: true, permitId: 'permit:' + request.actionId };
      } catch {
        return { ok: false };
      }
    },
    transport: createPostTransportCrashTransport(createPinnedTransport(), {
      enabled: postTransportCrash,
    }),
  });

  const git = new GovernedGitEgress({
    broker,
    audit: (event) => gw._audit(event),
  });
  const result = await git.execute({
    tenantId: context.tenant_id,
    principalId: context.principal_id,
    missionId: context.mission_id,
    authorityRef: context.authority_lease_id,
    credentialHandle: handle.handleId,
    executionContextId: context.execution_context_id,
    actionId: args.action_id,
    effectId: args.effect_id,
    correlationId: args.causal_id,
    requestId: args.request_id,
    repository,
    ref,
    operation: 'push',
    newSha: args.new_sha,
    force: args.force === true,
  });
  const status = Number(result.result && result.result.status || 0);
  if (status < 200 || status >= 300) {
    const err = new Error('study015_git_transport_non_success');
    err.code = 'study015_git_transport_non_success';
    throw err;
  }
  return {
    schema: 'study015.governed-git-effect/1.0',
    ok: true,
    status,
    execution_context_id: context.execution_context_id,
    execution_pdr_id: platformExecution.pdr.id,
    action_id: args.action_id,
    effect_id: args.effect_id,
    causal_id: args.causal_id,
    repository,
    ref,
    new_sha: args.new_sha,
    admission_id: result.admission.admissionId,
  };
});

const server = http.createServer((req, res) => gw.handle(req, res));
server.listen(port, '127.0.0.1', () => {
  const addr = server.address();
  const receipt = {
    schema: 'study015.live-tg-ready/1.0',
    base_url: 'http://127.0.0.1:' + addr.port,
    repository,
    ref,
    organization_id: organizationId,
    tenant_id: tenantId,
    principal_id: principalId,
    mission_id: missionId,
    authority_lease_id: authorityRef,
    audit_file: auditFile,
    fault_mode: postTransportCrash ? 'post_transport_success_sigkill' : 'none',
    reconciliation_recorded: reconciliationRecorded,
  };
  fs.mkdirSync(path.dirname(readyOut), { recursive: true });
  fs.writeFileSync(readyOut, JSON.stringify(receipt) + '\n', { mode: 0o600 });
  process.stdout.write('STUDY015_TG_READY ' + receipt.base_url + '\n');
});

function shutdown() {
  server.close(() => {
    try { dbmod.closeDb(); } catch {}
    process.exit(0);
  });
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
