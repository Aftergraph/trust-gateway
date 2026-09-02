'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { HashChain } = require('../src/gateway/hash-chain');
const { searchChain } = require('../src/gateway/search');

test('searchChain: empty chain returns no hits', () => {
  const chain = new HashChain();
  const r = searchChain(chain, 'shell');
  assert.equal(r.hits.length, 0);
});

test('searchChain: matches tool name in payload', () => {
  const chain = new HashChain();
  chain.append({ type: 'action_decision', bot: 'forge', tool: 'shell.run' });
  chain.append({ type: 'action_executed', bot: 'forge', tool: 'fs.read' });
  const r = searchChain(chain, 'shell');
  assert.equal(r.hits.length, 1);
  assert.equal(r.hits[0].payload.tool, 'shell.run');
});

test('searchChain: case-insensitive match', () => {
  const chain = new HashChain();
  chain.append({ type: 'action_decision', bot: 'forge', tool: 'Shell.Run' });
  const r = searchChain(chain, 'SHELL');
  assert.equal(r.hits.length, 1);
});

test('searchChain: matches bot name', () => {
  const chain = new HashChain();
  chain.append({ type: 'action_decision', bot: 'atlas', tool: 'fs.read' });
  const r = searchChain(chain, 'atlas');
  assert.equal(r.hits.length, 1);
});

test('searchChain: respects limit', () => {
  const chain = new HashChain();
  for (let i = 0; i < 100; i++) {
    chain.append({ type: 'action_decision', bot: 'forge', tool: 'shell.run' });
  }
  const r = searchChain(chain, 'shell', { limit: 5 });
  assert.equal(r.hits.length, 5);
});

test('searchChain: empty query returns no hits', () => {
  const chain = new HashChain();
  chain.append({ type: 'action_decision', bot: 'forge', tool: 'shell.run' });
  const r = searchChain(chain, '');
  assert.equal(r.hits.length, 0);
});

test('searchChain: null chain returns error', () => {
  const r = searchChain(null, 'test');
  assert.ok(r.error);
});

test('searchChain: newest-first ordering', () => {
  const chain = new HashChain();
  chain.append({ type: 'action_decision', bot: 'forge', tool: 'fs.read', note: 'first' });
  chain.append({ type: 'action_decision', bot: 'forge', tool: 'fs.read', note: 'second' });
  chain.append({ type: 'action_decision', bot: 'forge', tool: 'fs.read', note: 'third' });
  const r = searchChain(chain, 'read', { limit: 2 });
  assert.equal(r.hits.length, 2);
  assert.equal(r.hits[0].payload.note, 'third');
  assert.equal(r.hits[1].payload.note, 'second');
});
