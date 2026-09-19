'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { authorizeV21Action } = require('../src/gateway/platform-execution');

const IDS = {
  action: 'act_11111111111111111111111111111111',
  context: 'ctx_22222222222222222222222222222222',
  tenant: 'ten_33333333333333333333333333333333',
  principal: 'prn_44444444444444444444444444444444',
  authority: 'auth_55555555555555555555555555555555',
  pdr: 'pdr_66666666666666666666666666666666',
  org: 'org_77777777777777777777777777777777',
  mission: 'mis_example',
};

function baseDeps(overrides = {}) {
  return {
    resolvePlatformIdentity: () => ({
      status: 200,
      body: {
        organization_id: IDS.org,
        tenant_id: IDS.tenant,
        principal_id: IDS.principal,
      },
    }),
    getExecutionContext: async () => ({
      ok: true,
      context: {
        schema: 'execution-context/1.0',
        execution_context_id: IDS.context,
        organization_id: IDS.org,
        tenant_id: IDS.tenant,
        principal_id: IDS.principal,
        mission_id: IDS.mission,
        authority_lease_id: IDS.authority,
      },
    }),
    revalidate: () => ({
      ok: true,
      action_id: IDS.action,
      authority_lease_id: IDS.authority,
    }),
    createExecutionDecision: (input) => ({ id: IDS.pdr, ...input }),
    ...overrides,
  };
}

function input(deps) {
  return {
    req: {},
    gw: {},
    body: {
      action_id: IDS.action,
      execution_context_id: IDS.context,
      mission_id: IDS.mission,
    },
    bot: { name: 'worker' },
    tool: 'fs.read:x',
    args: null,
    deps,
  };
}

test('valid V2.1 action binds current identity, context, live authority and execution PDR', async () => {
  let persisted = null;
  const deps = baseDeps({
    createExecutionDecision: (record) => {
      persisted = record;
      return { id: IDS.pdr, ...record };
    },
  });
  const out = await authorizeV21Action(input(deps));
  assert.equal(out.legacy, false);
  assert.equal(out.context.execution_context_id, IDS.context);
  assert.equal(out.revalidation.authority_lease_id, IDS.authority);
  assert.equal(out.pdr.id, IDS.pdr);
  assert.deepEqual(persisted, {
    action_id: IDS.action,
    phase: 'execution',
    tenant_id: IDS.tenant,
    principal_id: IDS.principal,
    mission_id: IDS.mission,
    authority_lease_id: IDS.authority,
    execution_context_id: IDS.context,
    allow: true,
    reason: 'admitted',
  });
});

test('unknown or cross-tenant execution context fails before AIE and PDR', async () => {
  for (const deps of [
    baseDeps({ getExecutionContext: async () => ({ ok: false, reason: 'execution_context_not_found' }) }),
    baseDeps({
      getExecutionContext: async () => ({
        ok: true,
        context: {
          schema: 'execution-context/1.0',
          execution_context_id: IDS.context,
          organization_id: IDS.org,
          tenant_id: 'ten_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
          principal_id: IDS.principal,
          mission_id: IDS.mission,
          authority_lease_id: IDS.authority,
        },
      }),
    }),
  ]) {
    let rvCalls = 0;
    let pdrCalls = 0;
    deps.revalidate = () => { rvCalls++; return { ok: true }; };
    deps.createExecutionDecision = () => { pdrCalls++; return {}; };
    await assert.rejects(() => authorizeV21Action(input(deps)));
    assert.equal(rvCalls, 0);
    assert.equal(pdrCalls, 0);
  }
});

test('revoked or expired authority fails before PDR', async () => {
  for (const [code, expected] of [
    ['AIE-AUTH-003', 'authority_revoked'],
    ['AIE-AUTH-002', 'lease_expired'],
  ]) {
    let pdrCalls = 0;
    const deps = baseDeps({
      revalidate: () => ({ ok: false, code }),
      createExecutionDecision: () => { pdrCalls++; return {}; },
    });
    await assert.rejects(
      () => authorizeV21Action(input(deps)),
      (err) => err.code === expected,
    );
    assert.equal(pdrCalls, 0);
  }
});

test('AIE lease identity must match immutable WORKS context', async () => {
  let pdrCalls = 0;
  const deps = baseDeps({
    revalidate: () => ({
      ok: true,
      action_id: IDS.action,
      authority_lease_id: 'auth_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    }),
    createExecutionDecision: () => { pdrCalls++; return {}; },
  });
  await assert.rejects(
    () => authorizeV21Action(input(deps)),
    (err) => err.code === 'execution_context_authority_mismatch',
  );
  assert.equal(pdrCalls, 0);
});

test('legacy request without execution_context_id bypasses V2.1 gate', async () => {
  const deps = baseDeps({
    resolvePlatformIdentity: () => { throw new Error('must not run'); },
  });
  const args = input(deps);
  delete args.body.execution_context_id;
  const out = await authorizeV21Action(args);
  assert.deepEqual(out, { legacy: true });
});

test('V2.1 path requires canonical action and execution-context ids', async () => {
  const deps = baseDeps();
  const badAction = input(deps);
  badAction.body.action_id = 'legacy-action';
  await assert.rejects(() => authorizeV21Action(badAction), (err) => err.code === 'invalid_action_id');

  const badCtx = input(deps);
  badCtx.body.execution_context_id = 'ctx-not-canonical';
  await assert.rejects(() => authorizeV21Action(badCtx), (err) => err.code === 'invalid_execution_context_id');
});
