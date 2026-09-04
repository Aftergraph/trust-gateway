'use strict';
// P1 Project primitive v1 tests — canonical contract per 06-PROJECTS-MISSIONS-TASKS §1.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { ProjectStore } = require('../src/gateway/projects');

function mkStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'proj-'));
  return { store: new ProjectStore({ file: path.join(dir, 'projects.json') }), dir };
}

test('create: full canonical shape with defaults', () => {
  const { store } = mkStore();
  const p = store.create({ title: 'Roro Luxury House', description: 'lash store', goal: 'launch' });
  assert.match(p.id, /^project_/);
  assert.equal(p.status, 'active');
  assert.equal(p.health, 'healthy');
  assert.deepEqual(p.running_work, []);
  assert.deepEqual(p.needs_you, []);
  assert.deepEqual(p.blockers, []);
  assert.deepEqual(p.next_actions, []);
});

test('attach conversations + missions (correlation)', () => {
  const { store } = mkStore();
  const p = store.create({ title: 'T' });
  store.attach(p.id, 'conversations', 'conv_1');
  store.attach(p.id, 'conversations', 'conv_1'); // idempotent
  store.attach(p.id, 'missions', 'mission_abc');
  const got = store.get(p.id);
  assert.deepEqual(got.conversations, ['conv_1']);
  assert.deepEqual(got.missions, ['mission_abc']);
  assert.throws(() => store.attach(p.id, 'budgets', 'x'), /invalid kind/);
});

test('activity log: bounded to 50 entries, newest first', () => {
  const { store } = mkStore();
  const p = store.create({ title: 'T' });
  for (let i = 0; i < 55; i++) store.logActivity(p.id, 'work_completed', `task ${i}`);
  const got = store.get(p.id);
  assert.equal(got.recent_activity.length, 50, 'bounded tail');
  assert.equal(got.recent_activity[0].description, 'task 54', 'newest first');
});

test('needs_you: requires one known signal key; resolve removes', () => {
  const { store } = mkStore();
  const p = store.create({ title: 'T' });
  assert.throws(() => store.addNeedsYou(p.id, { nonsense: 'x' }), /requires one of/);
  store.addNeedsYou(p.id, { approval_request: 'approve deploy' });
  store.addNeedsYou(p.id, { budget_action: 'raise budget' });
  assert.equal(store.get(p.id).needs_you.length, 2);
  store.resolveNeedsYou(p.id, 0);
  const after = store.get(p.id);
  assert.equal(after.needs_you.length, 1);
  assert.equal(after.needs_you[0].budget_action, 'raise budget');
});

test('health degrades on blocker, restores when resolved; invalid values rejected', () => {
  const { store } = mkStore();
  const p = store.create({ title: 'T' });
  store.addBlocker(p.id, { type: 'dependency', description: 'waiting on api keys' });
  assert.equal(store.get(p.id).health, 'degraded');
  store.resolveBlocker(p.id, 0);
  assert.equal(store.get(p.id).health, 'healthy');
  assert.throws(() => store.setHealth(p.id, 'on_fire'), /invalid health/);
  assert.throws(() => store.addBlocker(p.id, { type: 'vibes', description: 'x' }), /invalid blocker type/);
});

test('status transitions: active/on_hold/archived, invalid rejected', () => {
  const { store } = mkStore();
  const p = store.create({ title: 'T' });
  store.setStatus(p.id, 'on_hold');
  assert.equal(store.get(p.id).status, 'on_hold');
  store.setStatus(p.id, 'archived');
  assert.equal(store.get(p.id).status, 'archived');
  assert.throws(() => store.setStatus(p.id, 'zombie'), /invalid status/);
});

test('persistence across instances', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'projp-'));
  const file = path.join(dir, 'projects.json');
  const s1 = new ProjectStore({ file });
  const p = s1.create({ title: 'persist' });
  s1.attach(p.id, 'missions', 'm_1');
  s1.logActivity(p.id, 'evidence_verified', 'chain ok');

  const s2 = new ProjectStore({ file });
  const got = s2.get(p.id);
  assert.deepEqual(got.missions, ['m_1']);
  assert.equal(got.recent_activity[0].type, 'evidence_verified');
});

test('unknown id throws', () => {
  const { store } = mkStore();
  assert.throws(() => store.attach('ghost', 'missions', 'm'), /unknown id/);
});