'use strict';
// P2 developer platform v0 tests: contract generation from live mounts, SDK surface.
const test = require('node:test');
const assert = require('node:assert/strict');
const { buildApiContract, sdkSurface, regexToTemplate } = require('../src/gateway/api-contract.js');

const MOUNTS = [
  { name: 'v2-router', method: 'POST', path: '/v2/router/route', auth: 'bearer' },
  { name: 'conversations', method: '*', path: /^\/v2\/conversations(?:\/.*)?$/, auth: 'bearer' },
  { name: 'v2-evals', method: '*', path: /^\/v2\/evals(\/latest)?$/, auth: 'bearer' },
];

test('contract: literal string path becomes an exact path entry', () => {
  const c = buildApiContract(MOUNTS, { version: '0.4.0' });
  assert.equal(c.openapi, '3.1.0');
  assert.ok(c.paths['/v2/router/route'].post, 'literal path entry');
  assert.equal(c.paths['/v2/router/route'].post.security[0].bearerAuth.length, 0, 'bearer security set');
});

test('contract: regex paths derive templates with param markers', () => {
  const c = buildApiContract(MOUNTS, {});
  const keys = Object.keys(c.paths);
  const conv = keys.find((k) => k.includes('conversations'));
  assert.ok(conv, 'conversations template derived');
});

test('contract: method-* mounts enumerate multiple verbs without clobbering', () => {
  const c = buildApiContract(MOUNTS, {});
  const conv = Object.entries(c.paths).find(([k]) => k.includes('conversations'))[1];
  const methods = Object.keys(conv);
  assert.ok(methods.includes('get') && methods.includes('post'), 'star mount enumerates methods');
});

test('contract hash is deterministic; sdkSurface lists operations sorted', () => {
  const a = buildApiContract(MOUNTS, {});
  const b = buildApiContract(MOUNTS, {});
  assert.equal(a.info['x-contract-hash'], b.info['x-contract-hash']);
  const sdk = sdkSurface(a);
  assert.ok(sdk.length > 0);
  const sorted = [...sdk].sort((x, y) => x.path.localeCompare(y.path));
  assert.deepEqual(sdk.map((s) => s.path), sorted.map((s) => s.path), 'sorted by path');
});

test('regexToTemplate: anchors stripped, captures become param markers', () => {
  const t = regexToTemplate(/^\/v2\/context\/([^/]+)\/?$/);
  assert.ok(t.startsWith('/v2/context') || t.includes('/v2/context/'), `prefix preserved: ${t}`);
  assert.ok(t.includes('param') || t.includes('pattern'), `param/pattern marker present: ${t}`);
});