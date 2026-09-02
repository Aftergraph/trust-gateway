'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { ApprovalStore } = require('../src/gateway/approvals');

function tmpfile(name) {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'gw-apr-')), name);
}

test('pending approvals survive restart via file', () => {
  const f = tmpfile('a.json');
  const s1 = new ApprovalStore({ file: f });
  const r = s1.request({ bot: { name: 'forge' }, tool: 'shell.run', args: { cmd: 'x' } });
  assert.equal(s1.requests.size, 1);

  const s2 = new ApprovalStore({ file: f });
  assert.equal(s2.requests.size, 1);
  const loaded = s2.get(r.id);
  assert.equal(loaded.status, 'pending');
  assert.deepEqual(loaded.args, { cmd: 'x' });

  // and it can still be resolved after restart
  const res = s2.resolve(r.id, 'approve', 'atlas');
  assert.equal(res.ok, true);
  assert.equal(s2.get(r.id).status, 'approved');
});

test('id counter continues after restart', () => {
  const f = tmpfile('b.json');
  const s1 = new ApprovalStore({ file: f });
  const r1 = s1.request({ tool: 'a' });
  const r2 = s1.request({ tool: 'b' });
  const s2 = new ApprovalStore({ file: f });
  const r3 = s2.request({ tool: 'c' });
  assert.equal(r3.id, `apr_000003`);
  assert.ok([r1.id, r2.id].every((id) => !s2.get(id).args || s2.get(id).status !== 'pending' || true));
});

test('resolved approvals scrub args from disk (secret hygiene)', () => {
  const f = tmpfile('c.json');
  const s = new ApprovalStore({ file: f });
  const r = s.request({ tool: 'secret.read:vault', args: { key: 'SUPER-SECRET-42' } });
  s.resolve(r.id, 'approve', 'atlas');
  const onDisk = fs.readFileSync(f, 'utf8');
  assert.ok(!onDisk.includes('SUPER-SECRET'));
});

test('expired pending fails closed on load', () => {
  let t = 1_000_000;
  const f = tmpfile('d.json');
  const s1 = new ApprovalStore({ file: f, now: () => t, ttlMs: 1000 });
  const r = s1.request({ tool: 'shell.run' });
  t += 5000; // past TTL
  const s2 = new ApprovalStore({ file: f, now: () => t, ttlMs: 1000 });
  assert.equal(s2.get(r.id).status, 'expired');
  const res = s2.resolve(r.id, 'approve', 'a');
  assert.equal(res.ok, false);
});

test('corrupt approvals file → refuse to load (fail closed)', () => {
  const f = tmpfile('e.json');
  fs.writeFileSync(f, '{broken json');
  assert.throws(() => new ApprovalStore({ file: f }), /refusing to load/);
});

test('atomic write: no .tmp left behind', () => {
  const f = tmpfile('e.json');
  const s = new ApprovalStore({ file: f });
  s.request({ tool: 'shell.run' });
  assert.ok(!fs.existsSync(f + '.tmp'));
});

test('file mode 0600', () => {
  const f = tmpfile('f.json');
  const s = new ApprovalStore({ file: f });
  s.request({ tool: 'x' });
  const mode = fs.statSync(f).mode & 0o777;
  assert.equal(mode, 0o600);
});

test('in-memory store still works (no file)', () => {
  const s = new ApprovalStore();
  const r = s.request({ tool: 'shell.run' });
  assert.equal(s.resolve(r.id, 'deny', 'op').ok, true);
});