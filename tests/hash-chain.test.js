'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { HashChain, entryHash, canonical } = require('../src/gateway/hash-chain');

test('genesis is valid', () => {
  const c = new HashChain();
  const v = c.verify();
  assert.equal(v.ok, true);
  assert.equal(v.length, 1);
  assert.equal(c.entries[0].payload.type, 'genesis');
});

test('append links entries', () => {
  const c = new HashChain();
  const e1 = c.append({ a: 1 });
  const e2 = c.append({ b: 2 });
  assert.equal(e1.seq, 1);
  assert.equal(e2.seq, 2);
  assert.equal(e2.prevHash, e1.hash);
  assert.equal(c.verify().ok, true);
});

test('canonical JSON is order-independent', () => {
  assert.equal(canonical({ a: 1, b: { c: 2, a: 1 } }), canonical({ b: { a: 1, c: 2 }, a: 1 }));
  assert.notEqual(canonical({ a: 1 }), canonical({ a: 2 }));
});

test('entryHash is deterministic and sensitive', () => {
  const h1 = entryHash(1, 'x', 100, { t: 'read' });
  const h2 = entryHash(1, 'x', 100, { t: 'read' });
  const h3 = entryHash(1, 'x', 101, { t: 'read' });
  assert.equal(h1, h2);
  assert.notEqual(h1, h3);
});

test('tampering with payload breaks chain', () => {
  const c = new HashChain();
  c.append({ a: 1 });
  c.append({ a: 2 });
  c.entries[1].payload.a = 999; // flip history
  const v = c.verify();
  assert.equal(v.ok, false);
  assert.equal(v.reason, 'hash_mismatch');
});

test('tampering with seq breaks chain', () => {
  const c = new HashChain();
  c.append({ a: 1 });
  c.append({ a: 2 });
  c.entries[2].seq = 5;
  assert.equal(c.verify().ok, false);
});

test('deleting an entry breaks chain', () => {
  const c = new HashChain();
  c.append({ a: 1 });
  c.append({ a: 2 });
  c.entries.splice(1, 1);
  assert.equal(c.verify().ok, false);
});

test('two chains have different genesis (replay protection)', () => {
  const a = new HashChain();
  const b = new HashChain();
  assert.notEqual(a.entries[0].payload.chainId, b.entries[0].payload.chainId);
  assert.notEqual(a.head.hash, b.head.hash);
});

test('since() filters by seq', () => {
  const c = new HashChain();
  for (let i = 0; i < 5; i++) c.append({ i });
  assert.equal(c.since(3).entries.length, 2);
  assert.equal(c.since(0).entries.length, 5); // genesis is seq 0, excluded
});

test('since() caps by limit and returns nextSince cursor', () => {
  const c = new HashChain();
  for (let i = 0; i < 10; i++) c.append({ i });
  const page = c.since(0, { limit: 4 });
  assert.equal(page.entries.length, 4);
  assert.equal(page.nextSince, 4);
  // next call paginates from after the cursor
  const page2 = c.since(page.nextSince, { limit: 4 });
  assert.equal(page2.entries.length, 4);
  assert.equal(page2.nextSince, 8);
  const tail = c.since(page2.nextSince);
  assert.equal(tail.entries.length, 2);
  assert.equal(tail.nextSince, null); // last page
});