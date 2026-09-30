'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-tool-action-http-'));
process.env.TG_DB_FILE = path.join(ROOT, 'gateway.db');
process.env.TG_DATA_DIR = path.join(ROOT, 'data');
process.env.TG_NEEDYOU_FILE = path.join(ROOT, 'needyou.json');
process.env.TG_TOOL_ACTIONS_FILE = path.join(ROOT, 'tool-actions.json');
process.env.TG_AIE_FAIL_OPEN = 'false';
delete process.env.AFTERGRAPH_TOOL_FABRIC_SNAPSHOT;
delete process.env.AFTERGRAPH_TOOL_POLICY_MAP;

const { Gateway } = require('../src/gateway/server');
const needYouMount = require('../src/gateway/mounts/08-need-you');
const toolActionMount = require('../src/gateway/mounts/162-tool-fabric-actions');

const tool = {
  schemaVersion: 'aftergraph.tool/v1',
  id: 'github.read',
  version: '1.0.0',
  kind: 'http',
  capabilities: ['github.pr.read'],
  runtime: 'gateway',
  credentialBindings: [],
  provenance: {
    source: 'Aftergraph/relay',
    revision: '1',
    digest: 'a'.repeat(64),
  },
};

function makeGateway() {
  const gw = new Gateway({
    port: 0,
    bots: {
      operator: {
        token: 'tok-operator',
        role: 'operator',
        capabilities: ['*'],
      },
    },
    mountFiles: false,
    mounts: [needYouMount, toolActionMount],
  });
  gw.toolFabricResolver = {
    async resolve({ toolId, capability, provenanceDigest }) {
      if (toolId !== tool.id || capability !== 'github.pr.read') return null;
      if (provenanceDigest !== tool.provenance.digest) return null;
      return { tool, policyTool: 'unknown.effect' };
    },
  };
  return gw;
}

function actionRequest(overrides = {}) {
  return {
    schemaVersion: 'aftergraph.tool-action-request/v1',
    requestId: 'req-http-1',
    toolId: 'github.read',
    capability: 'github.pr.read',
    toolProvenanceDigest: 'a'.repeat(64),
    principalId: 'operator',
    missionId: 'mission-1',
    executionContextId: 'ctx-1',
    idempotencyKey: 'idem-http-1',
    argumentsDigest: 'b'.repeat(64),
    authorityGranted: false,
    credentialMaterialPresent: false,
    ...overrides,
  };
}

function request(port, method, urlPath, body = null) {
  return new Promise((resolve, reject) => {
    const rawBody = body == null ? null : JSON.stringify(body);
    const req = http.request({
      host: '127.0.0.1',
      port,
      method,
      path: urlPath,
      headers: {
        authorization: 'Bearer tok-operator',
        'content-type': 'application/json',
        ...(rawBody ? { 'content-length': Buffer.byteLength(rawBody) } : {}),
      },
    }, (res) => {
      let raw = '';
      res.on('data', (chunk) => { raw += chunk; });
      res.on('end', () => {
        let parsed = {};
        try { parsed = raw ? JSON.parse(raw) : {}; } catch {}
        resolve({ status: res.statusCode, body: parsed });
      });
    });
    req.on('error', reject);
    if (rawBody) req.write(rawBody);
    req.end();
  });
}

async function boot(gw) {
  const server = http.createServer((req, res) => gw.handle(req, res));
  const port = await new Promise((resolve) =>
    server.listen(0, '127.0.0.1', () => resolve(server.address().port))
  );
  return { server, port };
}

test('HomeOS ToolFabric request parks one NeedsYou approval and approve never dispatches', async () => {
  const gw = makeGateway();
  let dispatched = false;
  gw._run = async () => {
    dispatched = true;
    throw new Error('ToolFabric proposal approval must not dispatch');
  };

  const { server, port } = await boot(gw);
  try {
    const first = await request(port, 'POST', '/v2/tool-fabric/actions/request', actionRequest());
    assert.equal(first.status, 409);
    assert.equal(first.body.decision, 'pending_approval');
    assert.match(first.body.approvalId, /^nys_/);
    assert.equal(first.body.proposal.state, 'pending_approval');
    assert.equal(first.body.authorityGranted, false);
    assert.equal(first.body.credentialMaterialPresent, false);

    const repeated = await request(port, 'POST', '/v2/tool-fabric/actions/request', actionRequest());
    assert.equal(repeated.status, 409);
    assert.equal(repeated.body.approvalId, first.body.approvalId);

    const now = await request(port, 'GET', '/v2/need-you/now');
    assert.equal(now.status, 200);
    const related = now.body.items.filter((item) => item.id === first.body.approvalId);
    assert.equal(related.length, 1);
    assert.equal(related[0].type, 'approval');

    const status = await request(port, 'GET', '/v2/tool-fabric/actions/req-http-1');
    assert.equal(status.status, 200);
    assert.equal(status.body.proposal.state, 'pending_approval');

    const bypass = await request(port, 'POST', `/v2/need-you/${first.body.approvalId}/resolve`, {});
    assert.equal(bypass.status, 409);
    assert.equal(bypass.body.error, 'tool_action_resolution_required');

    const stillPending = await request(port, 'GET', '/v2/tool-fabric/actions/req-http-1');
    assert.equal(stillPending.body.proposal.state, 'pending_approval');

    const approved = await request(
      port,
      'POST',
      '/v2/tool-fabric/actions/req-http-1/resolve',
      { decision: 'approve', approvalId: first.body.approvalId },
    );
    assert.equal(approved.status, 200);
    assert.equal(approved.body.proposal.state, 'approved');
    assert.equal(approved.body.executionReady, false);
    assert.equal(approved.body.dispatchCreated, false);
    assert.equal(approved.body.authorityGranted, false);
    assert.equal(dispatched, false);

    const after = await request(port, 'GET', '/v2/need-you/now');
    assert.equal(after.body.items.some((item) => item.id === first.body.approvalId), false);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('human approval fails closed if trusted ToolFabric resolution drifts during pause', async () => {
  const gw = makeGateway();
  const { server, port } = await boot(gw);
  try {
    const pending = await request(port, 'POST', '/v2/tool-fabric/actions/request', actionRequest({
      requestId: 'req-http-drift',
      idempotencyKey: 'idem-http-drift',
    }));
    assert.equal(pending.status, 409);
    assert.match(pending.body.approvalId, /^nys_/);

    gw.toolFabricResolver = { async resolve() { return null; } };

    const approve = await request(
      port,
      'POST',
      '/v2/tool-fabric/actions/req-http-drift/resolve',
      { decision: 'approve', approvalId: pending.body.approvalId },
    );
    assert.equal(approve.status, 409);
    assert.equal(approve.body.error, 'revalidation_failed');

    const status = await request(port, 'GET', '/v2/tool-fabric/actions/req-http-drift');
    assert.equal(status.body.proposal.state, 'pending_approval');

    const now = await request(port, 'GET', '/v2/need-you/now');
    assert.equal(now.body.items.some((item) => item.id === pending.body.approvalId), true);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('deny resolves NeedsYou but still creates no dispatch', async () => {
  const gw = makeGateway();
  let dispatched = false;
  gw._run = async () => { dispatched = true; };
  const { server, port } = await boot(gw);
  try {
    const pending = await request(port, 'POST', '/v2/tool-fabric/actions/request', actionRequest({
      requestId: 'req-http-deny',
      idempotencyKey: 'idem-http-deny',
    }));
    const denied = await request(
      port,
      'POST',
      '/v2/tool-fabric/actions/req-http-deny/resolve',
      { decision: 'deny', approvalId: pending.body.approvalId },
    );
    assert.equal(denied.status, 200);
    assert.equal(denied.body.proposal.state, 'denied');
    assert.equal(denied.body.executionReady, false);
    assert.equal(dispatched, false);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
