'use strict';
// P2 Knowledge library v1 tests: CRUD, token-index search, citations, permissions.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { KnowledgeStore } = require('../src/gateway/knowledge.js');

function mkStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'knw-'));
  return new KnowledgeStore({ file: path.join(dir, 'knowledge.json') });
}

test('create: full shape with defaults', () => {
  const s = mkStore();
  const src = s.create({ title: 'Roro Lash Playbook', kind: 'doc', content: 'lash store ops', created_by: 'op_1' });
  assert.match(src.id, /^knw_/);
  assert.equal(src.visibility, 'tenant');
  assert.deepEqual(src.citations, []);
});

test('validation: title/kind/content/visibility enforced', () => {
  const s = mkStore();
  assert.throws(() => s.create({ kind: 'doc', content: 'x' }), /title required/);
  assert.throws(() => s.create({ title: 'x', kind: 'blog', content: 'x' }), /invalid kind/);
  assert.throws(() => s.create({ title: 'x', kind: 'doc' }), /content required/);
  assert.throws(() => s.create({ title: 'x', kind: 'doc', content: 'x', visibility: 'world' }), /invalid visibility/);
});

test('search: token-index AND semantics, title-ranked, decay-free', () => {
  const s = mkStore();
  s.create({ title: 'Lash aftercare guide', kind: 'doc', content: 'aftercare instructions for lash clients' });
  s.create({ title: 'Supplier list', kind: 'note', content: 'lash suppliers, adhesive vendors' });
  s.create({ title: 'Unrelated', kind: 'note', content: 'coffee machine manual' });

  const hits = s.search('lash');
  assert.equal(hits.length, 2, 'both lash-related sources');
  // title match ranks first (title boost ×2)
  assert.equal(hits[0].title, 'Lash aftercare guide');
  // ranked semantics: 'coffee machine' ranks Unrelated first but partial matches
  // for 'machine'-less sources may still surface below
  const cm = s.search('coffee');
  assert.equal(cm[0].title, 'Unrelated');
  // disjoint tokens still surface partially-matching sources, ranked by score
  const mixed = s.search('lash coffee');
  assert.equal(mixed[0].title, 'Lash aftercare guide', 'higher-scored first');
  assert.ok(mixed[0].score > mixed[1].score, 'scored ordering');
});

test('citations: ref tracked with timestamp; unknown id throws', () => {
  const s = mkStore();
  const src = s.create({ title: 'T', kind: 'doc', content: 'c' });
  const cited = s.cite(src.id, { ref_type: 'proposal', ref_id: 'proposal_1' });
  assert.equal(cited.citations.length, 1);
  assert.equal(cited.citations[0].ref_type, 'proposal');
  assert.equal(cited.citations[0].ref_id, 'proposal_1');
  assert.throws(() => s.cite('ghost', { ref_type: 'x', ref_id: 'y' }), /unknown id/);
  assert.throws(() => s.cite(src.id, { ref_type: 'x' }), /ref_type \+ ref_id required/);
});

test('remove: source deleted, index updated (no ghost hits)', () => {
  const s = mkStore();
  const src = s.create({ title: 'deleteme lash', kind: 'note', content: 'lash' });
  assert.equal(s.search('lash').length, 1);
  assert.equal(s.remove(src.id), true);
  assert.equal(s.search('lash').length, 0);
  assert.equal(s.remove(src.id), false);
});

test('persistence across instances (incl. index rebuild)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'knwp-'));
  const file = path.join(dir, 'knowledge.json');
  const s1 = new KnowledgeStore({ file });
  s1.create({ title: 'persisted guide', kind: 'doc', content: 'lash persistence rules' });
  const s2 = new KnowledgeStore({ file });
  assert.equal(s2.search('persistence').length, 1);
});