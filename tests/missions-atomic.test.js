'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { MissionProposalStore } = require('../src/gateway/missions');

function makeFile() {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'tg-mission-')), 'missions.json');
}

test('missions: write mode 0600 on posix, no tmp residue', () => {
  const file = makeFile();
  const store = new MissionProposalStore({ file });
  store.create({ proposer: 'forge', objective: 'test 0600' });
  assert.ok((fs.statSync(file).mode & 0o777) === 0o600 || process.platform === 'win32');
  assert.equal(fs.existsSync(file + '.tmp'), false);
});

test('missions: corrupt file fails closed', () => {
  const file = makeFile();
  fs.writeFileSync(file, '{notjson');
  assert.throws(() => new MissionProposalStore({ file }), /refusing to load/);
});

test('missions: CRUD round-trip', () => {
  const file = makeFile();
  const store = new MissionProposalStore({ file });
  store.create({ proposer: 'alice', objective: 'secure perimeter' });
  assert.equal(store.list().length, 1);
  assert.equal(store.list()[0].proposer, 'alice');
});

test('missions: restart reloads data', () => {
  const file = makeFile();
  const first = new MissionProposalStore({ file });
  first.create({ proposer: 'alice', objective: 'persist test' });
  const second = new MissionProposalStore({ file });
  assert.equal(second.list().length, 1);
  assert.equal(second.list()[0].objective, 'persist test');
});