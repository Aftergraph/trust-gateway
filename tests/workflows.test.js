'use strict';
// P2 Workflow primitive v1 tests: validation, lifecycle, versioning, WORKS mapping.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { WorkflowStore } = require('../src/gateway/workflows.js');

function mkStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-'));
  return new WorkflowStore({ file: path.join(dir, 'workflows.json') });
}

const STEPS = [
  { id: 'build', run: 'npm run build' },
  { id: 'test', run: 'npm test', depends_on: ['build'] },
  { id: 'deploy', run: './deploy.sh', depends_on: ['test'] },
];

test('create: valid workflow with draft status', () => {
  const s = mkStore();
  const w = s.create({ name: 'deploy pipeline', steps: STEPS });
  assert.match(w.id, /^wf_/);
  assert.equal(w.version, 1);
  assert.equal(w.status, 'draft');
  assert.deepEqual(w.triggers, [{ type: 'manual' }]);
});

test('validation: empty steps, missing run, dup id, unknown dep, cycle — all rejected', () => {
  const s = mkStore();
  assert.throws(() => s.create({ name: 'x', steps: [] }), /steps required/);
  assert.throws(() => s.create({ name: 'x', steps: [{ id: 'a' }] }), /run required/);
  assert.throws(() => s.create({ name: 'x', steps: [
    { id: 'a', run: 'x' }, { id: 'a', run: 'y' },
  ] }), /duplicated/);
  assert.throws(() => s.create({ name: 'x', steps: [
    { id: 'a', run: 'x', depends_on: ['ghost'] },
  ] }), /unknown step/);
  assert.throws(() => s.create({ name: 'x', steps: [
    { id: 'a', run: 'x', depends_on: ['b'] },
    { id: 'b', run: 'y', depends_on: ['a'] },
  ] }), /cycle/);
});

test('update bumps version + archives history; invalid steps rejected', () => {
  const s = mkStore();
  const w = s.create({ name: 'v1 flow', steps: STEPS });
  const v2steps = [...STEPS, { id: 'notify', run: 'notify.sh', depends_on: ['deploy'] }];
  const u = s.update(w.id, { steps: v2steps });
  assert.equal(u.version, 2);
  assert.equal(u.history.length, 1);
  assert.equal(u.history[0].version, 1);
  assert.throws(() => s.update(w.id, { steps: [{ id: 'bad', run: '' }] }), /run required/);
});

test('lifecycle: draft -> active -> archived; invalid trigger types rejected', () => {
  const s = mkStore();
  const w = s.create({ name: 'T', steps: STEPS });
  s.activate(w.id);
  assert.equal(s.get(w.id).status, 'active');
  s.archive(w.id);
  assert.equal(s.get(w.id).status, 'archived');
  assert.throws(() => s.update(w.id, { triggers: [{ type: 'pigeon' }] }), /invalid trigger type/);
});

test('toWorksWork: maps steps to WORKS workgraph with needs edges', () => {
  const s = mkStore();
  const w = s.create({ name: 'T', steps: STEPS });
  const body = s.toWorksWork(w);
  assert.equal(body.graph.nodes.test.needs[0], 'build');
  assert.equal(body.graph.nodes.deploy.run, './deploy.sh');
  assert.equal(body.correlation_id, `workflow_${w.id}_v1`);
  assert.equal(body.source.workflow_id, w.id);
});

test('persistence across instances', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wfp-'));
  const file = path.join(dir, 'workflows.json');
  const s1 = new WorkflowStore({ file });
  const w = s1.create({ name: 'persist', steps: STEPS });
  const s2 = new WorkflowStore({ file });
  assert.equal(s2.get(w.id).version, 1);
  assert.equal(s2.get(w.id).name, 'persist');
});