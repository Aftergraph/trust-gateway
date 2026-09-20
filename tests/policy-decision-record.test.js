'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function freshStore(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-pdr-'));
  t.after(() => {
    try { require('../src/gateway/db').closeDb(); } catch {}
    fs.rmSync(dir, { recursive: true, force: true });
  });
  process.env.TG_DB_FILE = path.join(dir, 'gateway.db');
  delete require.cache[require.resolve('../src/gateway/db')];
  delete require.cache[require.resolve('../src/gateway/policy-decision-record')];
  const db = require('../src/gateway/db');
  db.resetDb();
  return require('../src/gateway/policy-decision-record');
}

const base = {
  action_id: 'act_11111111111111111111111111111111',
  phase: 'execution',
  tenant_id: 'ten_22222222222222222222222222222222',
  principal_id: 'prn_33333333333333333333333333333333',
  mission_id: 'mis_example',
  authority_lease_id: 'auth_44444444444444444444444444444444',
  execution_context_id: 'ctx_55555555555555555555555555555555',
  allow: true,
  reason: 'admitted',
};

test('execution PDR persists durably and identical replay returns same id', t => {
  const store = freshStore(t);
  const first = store.createExecutionDecision(base, () => '2026-09-20T00:00:00.000Z');
  assert.match(first.id, /^pdr_[a-f0-9]{32}$/);
  const second = store.createExecutionDecision(base, () => '2026-09-20T00:01:00.000Z');
  assert.equal(second.id, first.id);
  assert.equal(store.getExecutionDecision(base.action_id).id, first.id);
});

test('same action cannot be rebound to another context or authority', t => {
  const store = freshStore(t);
  store.createExecutionDecision(base);
  assert.throws(
    () => store.createExecutionDecision({
      ...base,
      authority_lease_id: 'auth_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    }),
    /execution_pdr_conflict/,
  );
  assert.throws(
    () => store.createExecutionDecision({
      ...base,
      execution_context_id: 'ctx_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
    }),
    /execution_pdr_conflict/,
  );
});

test('execution PDR validates canonical platform identities', t => {
  const store = freshStore(t);
  for (const patch of [
    { action_id: 'legacy-action' },
    { tenant_id: 'main' },
    { principal_id: 'worker' },
    { authority_lease_id: 'lse_44444444444444444444444444444444' },
    { execution_context_id: 'ctx-bad' },
  ]) {
    assert.throws(() => store.createExecutionDecision({ ...base, ...patch }));
  }
});
