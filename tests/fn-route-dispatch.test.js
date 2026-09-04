const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { Gateway } = require('../src/gateway/server');

// Contract tests for the fn-route dispatch wiring (server.js router facade).
// These pin the LIVE gateway behavior that the 2026-09-04 smoke exposed:
// req.bot must be set on raw req, :param paths must match, RBAC must gate.

describe('fn-route dispatch contract', () => {
  let gw;

  before(() => {
    gw = new Gateway({ mountFiles: true, mountFilesBots: undefined });
  });

  it('wires function-style mounts into _fnRoutes', () => {
    assert.ok(Array.isArray(gw._fnRoutes));
    assert.ok(gw._fnRoutes.length >= 60, `expected >=60 fn routes, got ${gw._fnRoutes.length}`);
  });

  it('matcher supports :param segments', () => {
    const m = gw._matchFunctionRoute('GET', '/v2/metrics/tenant/acme');
    assert.ok(m, ':param path must match');
    assert.ok(m.params && m.params[1] === 'acme');
  });

  it('matcher does not cross methods', () => {
    const m = gw._matchFunctionRoute('DELETE', '/v2/metrics/tenant/acme');
    assert.equal(m, null);
  });

  it('matcher returns null for unknown paths', () => {
    assert.equal(gw._matchFunctionRoute('GET', '/v2/nope/missing'), null);
  });

  it('matcher handles exact string paths', () => {
    const m = gw._matchFunctionRoute('GET', '/v2/dashboard');
    assert.ok(m, 'exact path must match');
  });

  it('isOperator(req) sees bot role from dispatch (req.bot)', async () => {
    const { isOperator } = require('../src/gateway/tenants');
    const fakeReq = { bot: { name: 'atlas', role: 'operator' } };
    assert.ok(isOperator(fakeReq), 'operator role must pass');
    const workerReq = { bot: { name: 'forge', role: 'worker', capabilities: ['fs.read'] } };
    assert.equal(isOperator(workerReq), null, 'worker must be refused');
    const anonReq = {};
    assert.equal(isOperator(anonReq), null, 'anon must be refused');
  });
});
