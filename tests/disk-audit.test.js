'use strict';
process.env.TG_AIE_FAIL_OPEN = 'true'; // no AIE runtime in unit tests; fail-open for unit tests only
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { loadChain } = require('../src/gateway/disk-audit');
const { HashChain } = require('../src/gateway/hash-chain');

function tmpfile(name) {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'gw-audit-')), name);
}

test('fresh file → genesis written to disk', () => {
  const f = tmpfile('a.jsonl');
  const { chain, droppedPartial } = loadChain(f);
  assert.equal(chain.entries.length, 1);
  assert.equal(droppedPartial, false);
  const onDisk = JSON.parse(fs.readFileSync(f, 'utf8').trim());
  assert.equal(onDisk.seq, 0);
  assert.equal(onDisk.payload.type, 'genesis');
});

test('append → reload → same chain, verified', () => {
  const f = tmpfile('b.jsonl');
  const { chain } = loadChain(f);
  const fd = fs.openSync(f, 'a');
  const e1 = chain.append({ type: 'x', n: 1 });
  const e2 = chain.append({ type: 'x', n: 2 });
  fs.writeSync(fd, JSON.stringify(e1) + '\n');
  fs.writeSync(fd, JSON.stringify(e2) + '\n');
  fs.closeSync(fd);
  const { chain: reloaded } = loadChain(f);
  assert.equal(reloaded.entries.length, 3);
  assert.equal(reloaded.verify().ok, true);
  assert.equal(reloaded.head.hash, e2.hash);
  assert.equal(reloaded.chainId, chain.chainId);
});

test('trailing partial line (crash mid-write) → dropped, chain loads', () => {
  const f = tmpfile('c.jsonl');
  const { chain } = loadChain(f);
  const lines = [JSON.stringify(chain.entries[0]), JSON.stringify(chain.append({ n: 1 })), JSON.stringify(chain.append({ n: 2 }))];
  fs.writeFileSync(f, lines.join('\n') + '\n{"seq":3,"prevHa'); // partial last line
  const { chain: reloaded, droppedPartial } = loadChain(f);
  assert.equal(droppedPartial, true);
  assert.equal(reloaded.entries.length, 3);
  assert.equal(reloaded.verify().ok, true);
});

test('tampered history line → REFUSES to load (fail closed)', () => {
  const f = tmpfile('d.jsonl');
  const { chain } = loadChain(f);
  const e1 = chain.append({ decision: 'deny' });
  const e2 = chain.append({ decision: 'allow' });
  fs.writeFileSync(f, [JSON.stringify(chain.entries[0]), JSON.stringify(e1), JSON.stringify({ ...e2, payload: { decision: 'deny' } })].join('\n') + '\n');
  assert.throws(() => loadChain(f), /refusing to load/);
});

test('broken non-trailing line → REFUSES to load', () => {
  const f = tmpfile('e.jsonl');
  const { chain } = loadChain(f);
  const e1 = chain.append({ n: 1 });
  fs.writeFileSync(f, [JSON.stringify(chain.entries[0]), 'GARBAGE{{{', JSON.stringify(e1)].join('\n') + '\n');
  assert.throws(() => loadChain(f), /unparseable entry/);
});

test('seq gap in file → REFUSES to load', () => {
  const f = tmpfile('f.jsonl');
  const { chain } = loadChain(f);
  const e1 = chain.append({ n: 1 });
  const forged = { ...chain.append({ n: 2 }), seq: 99 }; // renumber but keep old hash
  fs.writeFileSync(f, [JSON.stringify(chain.entries[0]), JSON.stringify(e1), JSON.stringify(forged)].join('\n') + '\n');
  assert.throws(() => loadChain(f), /seq_gap|refusing to load/);
});

test('missing genesis → REFUSES to load', () => {
  const f = tmpfile('g.jsonl');
  const c = new HashChain();
  const e = c.append({ n: 1 });
  fs.writeFileSync(f, JSON.stringify(e) + '\n');
  assert.throws(() => loadChain(f), /genesis|refusing to load/);
});

test('Gateway with auditFile survives restart with intact history', async () => {
  const { Gateway } = require('../src/gateway/server');
  const f = tmpfile('h.jsonl');
  const mkReqRes = (json, token) => {
    const { EventEmitter } = require('node:events');
    const req = new EventEmitter();
    req.method = 'POST';
    req.url = '/v1/actions';
    req.headers = token ? { authorization: `Bearer ${token}` } : {};
    const res = { writeHead() {}, end() {} };
    if (json) process.nextTick(() => { req.emit('data', Buffer.from(json)); req.emit('end'); });
    else process.nextTick(() => req.emit('end'));
    return { req, res };
  };
  // Run 1: two read actions → each produces 3 audit entries
  // (decision + revalidation-degraded audit [no AIE runtime in tests, fail-open] + executed)
  const gw1 = new Gateway({ bots: { a: { token: 't' } }, auditFile: f, dispatch: async () => ({ ok: 1 }) });
  await gw1.handle(...Object.values(mkReqRes(JSON.stringify({ tool: 'fs.read:x' }), 't')));
  await gw1.handle(...Object.values(mkReqRes(JSON.stringify({ tool: 'fs.read:y' }), 't')));
  assert.equal(gw1.chain.entries.length, 7);
  // Run 2: restart, history intact + continues
  const gw2 = new Gateway({ bots: { a: { token: 't' } }, auditFile: f, dispatch: async () => ({ ok: 1 }) });
  assert.equal(gw2.chain.entries.length, 7);
  assert.equal(gw2.chain.chainId, gw1.chain.chainId); // same chain!
  await gw2.handle(...Object.values(mkReqRes(JSON.stringify({ tool: 'fs.read:z' }), 't')));
  assert.equal(gw2.chain.entries.length, 10);
  assert.equal(gw2.chain.verify().ok, true);
  const onDisk = fs.readFileSync(f, 'utf8').trim().split('\n');
  assert.equal(onDisk.length, 10);
});