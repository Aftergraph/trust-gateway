'use strict';

const crypto = require('node:crypto');

function fail(code) {
  const err = new Error(code);
  err.code = code;
  return err;
}

function normalizeRepository(repository) {
  const value = String(repository || '').trim();
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(value)) throw fail('git_repository_invalid');
  return value;
}

function normalizeRef(ref) {
  const value = String(ref || '').trim();
  if (!/^refs\/heads\/[A-Za-z0-9._\/-]+$/.test(value) ||
      value.includes('..') || value.endsWith('/') || value.includes('//')) {
    throw fail('git_ref_invalid');
  }
  return value;
}

function normalizeSha(sha) {
  const value = String(sha || '').trim().toLowerCase();
  if (!/^[0-9a-f]{40}$/.test(value)) throw fail('git_sha_invalid');
  return value;
}

function classifyGitOperation(operation) {
  switch (String(operation || '').trim().toLowerCase()) {
    case 'fetch':
      return Object.freeze({ operation: 'fetch', effectClass: 'git.read', mutating: false });
    case 'push':
      return Object.freeze({ operation: 'push', effectClass: 'git.mutate', mutating: true });
    default:
      throw fail('git_operation_invalid');
  }
}

function sha256Body(body) {
  return 'sha256:' + crypto.createHash('sha256').update(body, 'utf8').digest('hex');
}

function encodeRefPath(ref) {
  return ref.replace(/^refs\//, '').split('/').map(encodeURIComponent).join('/');
}

function buildGitHubGitEgressRequest(input = {}) {
  const repository = normalizeRepository(input.repository);
  const ref = normalizeRef(input.ref);
  const classification = classifyGitOperation(input.operation);
  const tenantId = String(input.tenantId || '').trim();
  const principalId = String(input.principalId || '').trim();
  const missionId = String(input.missionId || '').trim();
  const authorityRef = String(input.authorityRef || '').trim();
  const credentialHandle = String(input.credentialHandle || '').trim();
  const executionContextId = String(input.executionContextId || '').trim();
  const actionId = String(input.actionId || '').trim();
  const effectId = String(input.effectId || '').trim();
  const correlationId = String(input.correlationId || '').trim();
  const requestId = String(input.requestId || '').trim();

  if (!tenantId || !principalId || !missionId || !authorityRef || !credentialHandle ||
      !executionContextId || !actionId || !effectId || !correlationId || !requestId) {
    throw fail('git_governance_binding_required');
  }

  const refPath = encodeRefPath(ref);
  const resourceRef = 'repo:' + repository;
  const basePath = '/repos/' + repository + '/git/';

  const request = {
    requestId,
    correlationId,
    tenantId,
    principalId,
    missionId,
    authorityRef,
    purpose: classification.mutating ? 'git_push' : 'git_fetch',
    credentialHandle,
    executionContextId,
    actionId,
    effectId,
    effectClass: classification.effectClass,
    destination: { scheme: 'https', host: 'api.github.com', port: 443 },
    http: {
      method: classification.mutating ? 'PATCH' : 'GET',
      path: basePath + (classification.mutating ? 'refs/' : 'ref/') + refPath,
      query: {},
      headers: {
        accept: 'application/vnd.github+json',
        'x-github-api-version': '2022-11-28',
        'x-aftergraph-effect-class': classification.effectClass,
      },
      bodyDigest: null,
    },
    data: {
      sensitivity: ['internal'],
      provenanceRefs: [resourceRef, 'execution-context:' + executionContextId, 'action:' + actionId, 'effect:' + effectId],
      resourceRef,
      lineageId: correlationId,
    },
    git: {
      repository,
      ref,
      operation: classification.operation,
      mutating: classification.mutating,
    },
  };

  if (classification.mutating) {
    const newSha = normalizeSha(input.newSha);
    const body = JSON.stringify({ sha: newSha, force: input.force === true });
    request.http.headers['content-type'] = 'application/json';
    request.http.body = body;
    request.http.bodyDigest = sha256Body(body);
    request.git.newSha = newSha;
  }

  return request;
}

class GovernedGitEgress {
  constructor({ broker, audit = () => {} } = {}) {
    if (!broker || typeof broker.admit !== 'function' || typeof broker.dispatch !== 'function') {
      throw fail('git_egress_broker_required');
    }
    this.broker = broker;
    this.audit = audit;
  }

  async execute(input) {
    const request = buildGitHubGitEgressRequest(input);
    this.audit({
      type: 'git_egress_requested',
      requestId: request.requestId,
      correlationId: request.correlationId,
      executionContextId: request.executionContextId,
      actionId: request.actionId,
      effectId: request.effectId,
      effectClass: request.effectClass,
      repository: request.git.repository,
      ref: request.git.ref,
      operation: request.git.operation,
    });
    const admission = await this.broker.admit(request);
    const result = await this.broker.dispatch(admission, request);
    this.audit({
      type: 'git_egress_completed',
      requestId: request.requestId,
      correlationId: request.correlationId,
      executionContextId: request.executionContextId,
      actionId: request.actionId,
      effectId: request.effectId,
      effectClass: request.effectClass,
      repository: request.git.repository,
      ref: request.git.ref,
      operation: request.git.operation,
      status: Number(result?.status || 0),
    });
    return { request, admission, result };
  }
}

module.exports = {
  GovernedGitEgress,
  buildGitHubGitEgressRequest,
  classifyGitOperation,
  normalizeRepository,
  normalizeRef,
  normalizeSha,
};
