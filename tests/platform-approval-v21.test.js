'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { Gateway } = require('../src/gateway/server');

const IDS = {
  action: 'act_11111111111111111111111111111111',
  context: 'ctx_22222222222222222222222222222222',
  tenant: 'ten_33333333333333333333333333333333',
  principal: 'prn_44444444444444444444444444444444',
  authority: 'auth_55555555555555555555555555555555',
  pdr: 'pdr_66666666666666666666666666666666',
  org: 'org_77777777777777777777777777777777',
  mission: 'mis_approval_v21',
};

function mockReqRes(method, url, body, token) {
  const req = new EventEmitter();
  req.method = method;
  req.url = url;
  req.headers = token ? { authorization: `Bearer ${token}` } : {};
  let status = null;
  let output = null;
  const res = {
    writeHead(s) { status = s; },
    end(v) { output = v ? JSON.parse(v) : null; },
  };
  process.nextTick(() => {
    if (body != null) req.emit('data', Buffer.from(body));
    req.emit('end');
  });
  return { req, res, status: () => status, body: () => output };
}

function gateway({ platformAuthorize, dispatch }) {
  return new Gateway({
    mountFiles: false,
    bots: {
      worker: { token: 'worker-token', role: 'worker', capabilities: [] },
      operator: { token: 'operator-token', role: 'operator', capabilities: ['approval.decide'] },
    },
    dispatch,
    platformIdentityResolver: () => ({
      status: 200,
      body: {
        schema: 'platform-identity-projection/1.0',
        organization_id: IDS.org,
        tenant_id: IDS.tenant,
        principal_id: IDS.principal,
        principal_type: 'agent',
      },
    }),
    platformAuthorize,
  });
}

async function parkV21(gw) {
  const first = mockReqRes('POST', '/v1/actions', JSON.stringify({
    tool: 'shell.run',
    args: { cmd: 'deploy.sh' },
    action_id: IDS.action,
    execution_context_id: IDS.context,
    mission_id: IDS.mission,
  }), 'worker-token');
  await gw.handle(first.req, first.res);
  assert.equal(first.status(), 202);
  const approvalId = first.body().approvalId;
  const parked = gw.approvals.get(approvalId);
  assert.deepEqual(parked.platform_context, {
    action_id: IDS.action,
    execution_context_id: IDS.context,
    mission_id: IDS.mission,
    identity: {
      schema: 'platform-identity-projection/1.0',
      organization_id: IDS.org,
      tenant_id: IDS.tenant,
      principal_id: IDS.principal,
      principal_type: 'agent',
    },
  });
  return approvalId;
}

test('V2.1 approval reauthorizes and correlates before consequential dispatch', async () => {
  const order = [];
  const gw = gateway({
    platformAuthorize: async ({ body, bot, tool, args, deps }) => {
      order.push('authorize');
      assert.equal(bot.name, 'worker');
      assert.equal(tool, 'shell.run');
      assert.deepEqual(args, { cmd: 'deploy.sh' });
      assert.deepEqual(body, {
        action_id: IDS.action,
        execution_context_id: IDS.context,
        mission_id: IDS.mission,
      });
      assert.deepEqual(deps.resolvePlatformIdentity().body, {
        schema: 'platform-identity-projection/1.0',
        organization_id: IDS.org,
        tenant_id: IDS.tenant,
        principal_id: IDS.principal,
        principal_type: 'agent',
      });
      return {
        context: {
          execution_context_id: IDS.context,
          authority_lease_id: IDS.authority,
        },
        pdr: { id: IDS.pdr, action_id: IDS.action },
        correlation: { ok: true },
      };
    },
    dispatch: async () => {
      order.push('dispatch');
      return { ok: true };
    },
  });

  const approvalId = await parkV21(gw);
  const approved = mockReqRes('POST', `/v1/approvals/${approvalId}/approve`, '{}', 'operator-token');
  await gw.handle(approved.req, approved.res);

  assert.equal(approved.status(), 200);
  assert.deepEqual(order, ['authorize', 'dispatch']);
  assert.equal(approved.body().execution_context_id, IDS.context);
  assert.equal(approved.body().execution_pdr_id, IDS.pdr);
});

test('human approval never bypasses revoked V2.1 authority', async () => {
  let dispatchCalls = 0;
  const gw = gateway({
    platformAuthorize: async () => {
      const err = new Error('authority_revoked');
      err.status = 403;
      err.code = 'authority_revoked';
      throw err;
    },
    dispatch: async () => {
      dispatchCalls++;
      return { ok: true };
    },
  });

  const approvalId = await parkV21(gw);
  const approved = mockReqRes('POST', `/v1/approvals/${approvalId}/approve`, '{}', 'operator-token');
  await gw.handle(approved.req, approved.res);

  assert.equal(approved.status(), 403);
  assert.equal(approved.body().decision, 'deny');
  assert.equal(approved.body().error, 'authority_revoked');
  assert.equal(dispatchCalls, 0);
});
