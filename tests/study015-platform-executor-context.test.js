'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { Gateway } = require('../src/gateway/server');

const CTX = 'ctx_' + '8'.repeat(32);
const PDR = 'pdr_' + '9'.repeat(32);
const ACTION = 'act_' + 'a'.repeat(32);
const AUTH = 'auth_' + 'b'.repeat(32);
const ORG = 'org_' + '1'.repeat(32);
const TENANT = 'ten_' + '2'.repeat(32);
const PRINCIPAL = 'prn_' + '3'.repeat(32);
const MISSION = 'mis_study015_executor_context';

function fixture() {
  const seen = [];
  const identity = {
    schema: 'platform-identity-projection/1.0',
    organization_id: ORG,
    tenant_id: TENANT,
    principal_id: PRINCIPAL,
    principal_type: 'agent',
  };
  const execution = {
    context: {
      execution_context_id: CTX,
      mission_id: MISSION,
      authority_lease_id: AUTH,
      organization_id: ORG,
      tenant_id: TENANT,
      principal_id: PRINCIPAL,
    },
    pdr: { id: PDR, action_id: ACTION },
  };
  const gw = new Gateway({
    mountFiles: false,
    telemetryFile: null,
    bots: {
      worker: { token: 'worker-token', role: 'worker', capabilities: ['fs.write:*'] },
      operator: { token: 'operator-token', role: 'operator', capabilities: ['*'] },
    },
    platformIdentityResolver: () => ({ status: 200, body: identity }),
    platformAuthorize: async () => execution,
  });
  gw.registerExecutor(/^(fs\.write|shell\.run)/, async (bot, tool, args, platformExecution) => {
    seen.push({ bot, tool, args, platformExecution });
    return { ok: true };
  });
  return { gw, seen, execution };
}

async function boot(gw) {
  const server = http.createServer((req, res) => gw.handle(req, res));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    server,
    base: 'http://127.0.0.1:' + server.address().port,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

async function api(base, method, path, token, body) {
  const response = await fetch(base + path, {
    method,
    headers: {
      authorization: 'Bearer ' + token,
      'content-type': 'application/json',
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() };
}

test('direct platform action passes exact authorization result into executor', async () => {
  const { gw, seen, execution } = fixture();
  const ctx = await boot(gw);
  try {
    const response = await api(ctx.base, 'POST', '/v1/actions', 'worker-token', {
      action_id: ACTION,
      execution_context_id: CTX,
      mission_id: MISSION,
      tool: 'fs.write:/tmp/proof',
      args: { bounded: true },
    });
    assert.equal(response.status, 200);
    assert.equal(seen.length, 1);
    assert.equal(seen[0].platformExecution, execution);
    assert.equal(seen[0].platformExecution.context.execution_context_id, CTX);
    assert.equal(seen[0].platformExecution.pdr.id, PDR);
  } finally {
    await ctx.close();
  }
});

test('approved destructive action passes revalidated platform result into executor', async () => {
  const { gw, seen, execution } = fixture();
  const ctx = await boot(gw);
  try {
    const proposed = await api(ctx.base, 'POST', '/v1/actions', 'worker-token', {
      action_id: ACTION,
      execution_context_id: CTX,
      mission_id: MISSION,
      tool: 'shell.run',
      args: { cmd: 'true' },
    });
    assert.equal(proposed.status, 202);
    assert.match(proposed.body.approvalId, /^apr_/);
    assert.equal(seen.length, 0);

    const approved = await api(
      ctx.base,
      'POST',
      '/v1/approvals/' + proposed.body.approvalId + '/approve',
      'operator-token',
      {},
    );
    assert.equal(approved.status, 200);
    assert.equal(seen.length, 1);
    assert.equal(seen[0].platformExecution, execution);
    assert.equal(seen[0].platformExecution.context.execution_context_id, CTX);
    assert.equal(seen[0].platformExecution.pdr.id, PDR);
  } finally {
    await ctx.close();
  }
});
