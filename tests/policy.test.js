'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { classify, decide, capabilitiesFor } = require('../src/gateway/policy');

test('classification table', () => {
  assert.equal(classify('fs.read'), 'read');
  assert.equal(classify('fs.read:notes/todo.md'), 'read');
  assert.equal(classify('web.get'), 'read');
  assert.equal(classify('fs.write'), 'write');
  assert.equal(classify('fs.write:out.txt'), 'write');
  assert.equal(classify('shell.run'), 'destructive');
  assert.equal(classify('fs.delete:important'), 'destructive');
  assert.equal(classify('secret.read:API_KEY'), 'secret');
  assert.equal(classify('db.drop:prod'), 'destructive');
});

test('FAIL CLOSED: unknown tool is destructive', () => {
  assert.equal(classify('brandNewTool.nobody.saw'), 'destructive');
  assert.equal(classify(''), 'destructive');
  assert.equal(classify(undefined), 'destructive');
});

test('read always allowed', () => {
  const v = decide({ tool: 'fs.read:notes', cls: 'read', bot: { capabilities: [] } });
  assert.equal(v.decision, 'allow');
});

test('write allowed only with capability', () => {
  const yes = decide({ tool: 'fs.write:a.txt', cls: 'write', bot: { capabilities: ['fs.write:*'] } });
  const no = decide({ tool: 'fs.write:a.txt', cls: 'write', bot: { capabilities: [] } });
  assert.equal(yes.decision, 'allow');
  assert.equal(no.decision, 'needs_approval');
});

test('destructive ALWAYS needs approval, even with capability', () => {
  const v = decide({ tool: 'shell.run', cls: 'destructive', bot: { capabilities: ['shell.run', '*'] } });
  assert.equal(v.decision, 'needs_approval');
});

test('secret: capability but no approval → needs_approval; no capability → deny', () => {
  const gated = decide({ tool: 'secret.read:X', cls: 'secret', bot: { capabilities: ['secret.read:*'] } });
  const none = decide({ tool: 'secret.read:X', cls: 'secret', bot: { capabilities: [] } });
  assert.equal(gated.decision, 'needs_approval');
  assert.equal(none.decision, 'deny');
});

test('role capabilities', () => {
  assert.ok(capabilitiesFor('worker').includes('fs.write:*'));
  assert.ok(!capabilitiesFor('analyst').includes('shell.run'));
  const unknown = capabilitiesFor('nonexistent-role');
  assert.deepEqual(unknown, ['fs.read', 'web.get']); // safe default
});