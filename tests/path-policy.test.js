'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { canonicalPath, pathWithinPrefix } = require('../src/gateway/path-policy');

test('canonicalPath removes safe dot segments but preserves path identity', () => {
  assert.equal(canonicalPath('/repos/Aftergraph/example/./releases/'), '/repos/Aftergraph/example/releases/');
  assert.equal(canonicalPath('/repos/Aftergraph/example'), '/repos/Aftergraph/example');
  assert.equal(pathWithinPrefix('/repos/Aftergraph/example/releases', '/repos/Aftergraph/example'), true);
  assert.equal(pathWithinPrefix('/repos/Aftergraph/example-malicious/releases', '/repos/Aftergraph/example'), false);
});

test('encoded traversal, encoded separators, backslashes, and controls fail closed', () => {
  assert.throws(() => canonicalPath('/repos/Aftergraph/example/%2e%2e/other'), /path_encoded_separator/);
  assert.throws(() => canonicalPath('/repos/Aftergraph/example/%252e%252e/other'), /path_encoded_separator/);
  assert.throws(() => canonicalPath('/repos/Aftergraph/example%2Freleases'), /path_encoded_separator/);
  assert.throws(() => canonicalPath('/repos/Aftergraph/example\\releases'), /path_encoded_separator/);
  assert.throws(() => canonicalPath('/repos/Aftergraph/example/\u0000releases'), /path_control_character/);
});

test('root and trailing-slash prefix semantics are explicit', () => {
  assert.equal(pathWithinPrefix('/anything', '/'), true);
  assert.equal(pathWithinPrefix('/repos/Aftergraph/example', '/repos/Aftergraph/example/'), true);
  assert.equal(pathWithinPrefix('/repos/Aftergraph/examples', '/repos/Aftergraph/example/'), false);
});