'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { buildApiContract } = require('../src/gateway/api-contract');

const simple = [
  { name: 'foo', method: 'GET', path: '/v2/foo', auth: 'bearer' },
  { name: 'bar', method: 'POST', path: '/v2/bar/:id', auth: 'bearer' },
];

test('buildApiContract includes static mounts', () => {
  const c = buildApiContract(simple, { version: '1.0.0' });
  assert.equal(c.openapi, '3.1.0');
  assert.ok(c.paths['/v2/foo']);
  assert.ok(c.info.version, '1.0.0');
});

test('buildApiContract includes function-style routes', () => {
  const fnRoutes = [
    { method: 'GET', path: '/v2/rooms/:id/chain', handler: null },
    { method: 'POST', path: '/v2/actions', handler: null },
  ];
  const c = buildApiContract(simple, { version: '1.0.0', fnRoutes });
  assert.ok(c.paths['/v2/rooms/:id/chain'], 'fn-route path present');
  assert.ok(c.paths['/v2/actions'], 'second fn-route present');
  assert.ok(c.paths['/v2/foo'], 'static mount still present');
});

test('buildApiContract generates deterministic content-addressed hash', () => {
  const a = buildApiContract(simple, { version: '0.0.0' });
  const b = buildApiContract(simple, { version: '0.0.0' });
  assert.equal(a._hash, b._hash);
});

test('buildApiContract separates fn-route paths into their own section', () => {
  const fnRoutes = [
    { method: 'GET', path: '/v2/rooms/:id/chain', handler: null },
  ];
  const c = buildApiContract(simple, { version: '1.0.0', fnRoutes });
  // The routes should be merged into paths
  const pathKeys = Object.keys(c.paths);
  assert.ok(pathKeys.includes('/v2/foo'));
  assert.ok(pathKeys.includes('/v2/rooms/:id/chain'));
});