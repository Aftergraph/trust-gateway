'use strict';
// Regression: hashing must operate on the JSON round-tripped payload so that
// reload/verify agrees with append-time. Bug caught by v2 E2E 2026-09-02:
// chat audit payloads contain `undefined`-valued keys (argsSummary etc.) which
// vanish in JSON.stringify; hashing pre-roundtrip objects made verify() fail
// hash_mismatch on every persisted chain after one server restart cycle.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { HashChain } = require('../src/gateway/hash-chain');
const { SqlChain } = require('../src/gateway/sql-chain');

const weird = () => ({ type: 'chat_action', bot: 'forge', tool: 'fs.delete:x', argsLength: undefined, result: undefined, extra: { e: undefined } });

test('HashChain append+verify survives JSON-lossy payloads', () => {
  const c = new HashChain();
  c.append(weird());
  assert.equal(c.verify().ok, true);
});

test('SqlChain append+reload+verify survives JSON-lossy payloads', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gw-regress-'));
  const file = path.join(dir, 'chain.db');
  const c1 = new SqlChain({ file });
  c1.append(weird());
  c1.append(weird());
  const head1 = c1.head.hash;
  const c2 = new SqlChain({ file });
  assert.equal(c2.verify().ok, true, 'reloaded chain must verify');
  assert.equal(c2.head.hash, head1, 'head hash stable across reload');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('both implementations agree on hash for identical lossy payload', () => {
  const ts = 1_700_000_000_000;
  const payload = weird();
  const h = new HashChain({ chainId: 'fixed', genesisTs: ts });
  const he = h.append(payload, ts + 1);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gw-eq-'));
  const s = new SqlChain({ file: path.join(dir, 'c.db'), chainId: 'fixed', genesisTs: ts });
  const se = s.append(payload, ts + 1);
  assert.equal(se.hash, he.hash, 'cross-impl equivalence holds with lossy payload');
  fs.rmSync(dir, { recursive: true, force: true });
});
