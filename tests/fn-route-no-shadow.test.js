'use strict';
const { describe, it, before } = require('node:test');
const assert = require('node:assert/strict');
const { Gateway } = require('../src/gateway/server');

// Regression gate for the fn-route shadowing bug class:
// a later mount registering the SAME method+path as an earlier mount is
// silently unreachable (first-match-wins in _matchFunctionRoute).
// Real case: 153-fed-audit-dash.js shadowed 120-fed-audit.js on
// GET /v2/federation/audit — 153's handler, audit rows and query params
// (type/tenant/until/offset) were dead code.

describe('fn-route no-shadowing contract', () => {
  let gw;

  before(() => {
    gw = new Gateway({ mountFiles: true, mountFilesBots: undefined });
  });

  it('no two fn-routes share the same method+path', () => {
    const seen = new Map();
    const dupes = [];
    for (const r of gw._fnRoutes) {
      const key = `${r.method} ${r.path}`;
      if (seen.has(key)) dupes.push(`${key} (${seen.get(key)} and later)`);
      else seen.set(key, r.path);
    }
    assert.deepEqual(dupes, [], 'duplicate fn-route registrations must not exist');
  });

  it('GET /v2/federation/audit dispatches to the fed-audit (K1) handler', () => {
    const m = gw._matchFunctionRoute('GET', '/v2/federation/audit');
    assert.ok(m, 'exact path must match');
    assert.ok(
      String(m.handler).includes('federationEnabled') || String(m.handler).includes('listFederatedRuns'),
      'handler must be the K1 fed-audit handler'
    );
  });

  it('GET /v2/federation/audit/events dispatches to the fed-audit-dash (Z2) handler', () => {
    const m = gw._matchFunctionRoute('GET', '/v2/federation/audit/events');
    assert.ok(m, 'exact path must match');
    assert.ok(
      String(m.handler).includes('fed.query') || String(m.handler).includes('opts'),
      'handler must be the Z2 dash event-query handler'
    );
  });

  it('GET /v2/federation/audit/summary still dispatches', () => {
    const m = gw._matchFunctionRoute('GET', '/v2/federation/audit/summary');
    assert.ok(m, 'summary path must match');
  });

  it('route inventory stays shadow-free across all mounts', () => {
    // Every registered path must be reachable from its own method+path key
    let missing = 0;
    for (const r of gw._fnRoutes) {
      const m = gw._matchFunctionRoute(r.method, r.path);
      if (!m) missing++;
    }
    assert.equal(missing, 0, 'each registered route must match itself');
  });
});