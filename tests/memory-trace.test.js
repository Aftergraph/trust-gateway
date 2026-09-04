'use strict';
// Memory usage-trace + knows-about tests (P1 roadmap item).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { MemoryStore } = require('../src/gateway/memory.js');

function mkStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'memtrace-'));
  return new MemoryStore({ file: path.join(dir, 'memory.json') });
}

test('touch updates lastUsedAt + increments usageCount', () => {
  const store = mkStore();
  const f = store.create({ bot: 'b1', text: 'jonas prefers Danish', source: 'user' });
  const t1 = store.touch('b1', f.id);
  assert.equal(t1.usageCount, 1);
  assert.ok(t1.lastUsedAt, 'lastUsedAt stamped');
  const t2 = store.touch('b1', f.id);
  assert.equal(t2.usageCount, 2);
});

test('usageTrace ranks by usageCount, decay-aware', () => {
  const store = mkStore();
  const f1 = store.create({ bot: 'b1', text: 'fact one' });
  const f2 = store.create({ bot: 'b1', text: 'fact two' });
  const f3 = store.create({ bot: 'b1', text: 'fact decayed', decayAt: new Date(Date.now() - 1000).toISOString() });
  store.touch('b1', f1.id);
  store.touch('b1', f1.id);
  store.touch('b1', f2.id);
  const trace = store.usageTrace('b1');
  assert.equal(trace.total_active, 2, 'decayed f2? no — f3 decayed excluded');
  assert.equal(trace.facts[0].usageCount, 2, 'most-used first');
  assert.equal(trace.facts[0].id, f1.id);
});

test('knowsAbout: text + tag search, records usage touches', () => {
  const store = mkStore();
  const f1 = store.create({ bot: 'b1', text: 'Roro Luxury House is a lash store', tags: ['roro'] });
  const f2 = store.create({ bot: 'b1', text: 'unrelated fact' });
  const hits = store.knowsAbout('b1', 'roro');
  assert.equal(hits.length, 1);
  assert.equal(hits[0].id, f1.id);
  // usage touched
  assert.equal(store.get('b1', f1.id).usageCount, 1);
  assert.equal(store.get('b1', f2.id).usageCount || 0, 0, 'non-matching fact untouched');
});

test('knowsAbout excludes decayed facts by default', () => {
  const store = mkStore();
  store.create({ bot: 'b1', text: 'rotten knowledge', decayAt: new Date(Date.now() - 3600e3).toISOString() });
  assert.equal(store.knowsAbout('b1', 'rotten').length, 0, 'decayed facts not surfaced');
});

test('knowsAbout requires topic', () => {
  const store = mkStore();
  assert.throws(() => store.knowsAbout('b1', ''), /topic required/);
});

test('unknown bot: empty results, no crash', () => {
  const store = mkStore();
  assert.deepEqual(store.usageTrace('ghost').facts, []);
  assert.equal(store.touch('ghost', 'm_x'), null);
  assert.equal(store.knowsAbout('ghost', 'x').length, 0);
});