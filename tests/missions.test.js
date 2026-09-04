'use strict';
// W0.2 MissionProposal lifecycle tests + W0.3 mission_id correlation.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { MissionProposalStore } = require('../src/gateway/missions');

function mkStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'w02-'));
  return { store: new MissionProposalStore({ file: path.join(dir, 'proposals.json') }), dir };
}

test('proposal lifecycle: draft -> submitted -> approved with mission correlation', () => {
  const { store } = mkStore();
  const p = store.create({
    proposer: 'agent_9',
    channel: 'chat',
    objective: 'deploy site',
    context: 'user asked to ship',
    proposed_mission: { objective: 'deploy', success_criteria: ['deployed'], estimated_cost_eur: 0.5, estimated_duration: '10m' },
    reasoning: 'standard deploy',
  });
  assert.equal(p.status, 'draft');
  assert.throws(() => store.approve(p.id, 'op'), /cannot approve from status draft/);

  store.submit(p.id);
  const ap = store.approve(p.id, 'op-bot');
  assert.equal(ap.status, 'approved');
  assert.ok(ap.converted_to_mission_id, 'W0.3: correlation stamped');
  assert.equal(store.missionIdFor(p.id), ap.converted_to_mission_id);
});

test('reject flow stores reason', () => {
  const { store } = mkStore();
  const p = store.create({ proposer: 'a', objective: 'x' });
  store.submit(p.id);
  const r = store.reject(p.id, 'too expensive');
  assert.equal(r.status, 'rejected');
  assert.equal(r.rejection_reason, 'too expensive');
});

test('persistence across instances', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'w02p-'));
  const file = path.join(dir, 'proposals.json');
  const s1 = new MissionProposalStore({ file });
  const p = s1.create({ proposer: 'a', objective: 'persist me' });
  s1.submit(p.id);

  const s2 = new MissionProposalStore({ file });
  assert.equal(s2.get(p.id).status, 'submitted');
});

test('validation: proposer + objective required, channel enum', () => {
  const { store } = mkStore();
  assert.throws(() => store.create({ objective: 'x' }), /proposer/);
  assert.throws(() => store.create({ proposer: 'a' }), /objective/);
  assert.throws(() => store.create({ proposer: 'a', objective: 'x', channel: 'pigeon' }), /invalid channel/);
});

test('unknown id: get null, ops throw', () => {
  const { store } = mkStore();
  assert.equal(store.get('nope'), null);
  assert.throws(() => store.submit('nope'));
});

test('correlation: unknown proposal -> null mission id', () => {
  const { store } = mkStore();
  assert.equal(store.missionIdFor('ghost'), null);
});