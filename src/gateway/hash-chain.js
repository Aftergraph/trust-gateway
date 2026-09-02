'use strict';
// Trust Gateway — hash-chained, append-only audit log.
// Entry i = { seq, prevHash, ts, payload, hash }
// hash = sha256(seq + '|' + prevHash + '|' + ts + '|' + canonical(payload))
// Tampering with ANY entry breaks every subsequent hash.

const crypto = require('node:crypto');

function canonical(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value ?? null);
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  const keys = Object.keys(value).sort();
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + canonical(value[k])).join(',') + '}';
}

function sha256(s) {
  return crypto.createHash('sha256').update(s).digest('hex');
}

function entryHash(seq, prevHash, ts, payload) {
  return sha256(`${seq}|${prevHash}|${ts}|${canonical(payload)}`);
}

class HashChain {
  constructor({ chainId = crypto.randomUUID(), genesisTs = null } = {}) {
    this.chainId = chainId;
    this.entries = [];
    const ts = genesisTs ?? Date.now();
    const genesis = {
      seq: 0,
      prevHash: '0'.repeat(64),
      ts,
      payload: { type: 'genesis', chainId },
    };
    genesis.hash = entryHash(0, genesis.prevHash, ts, genesis.payload);
    this.entries.push(genesis);
  }

  get head() {
    return this.entries[this.entries.length - 1];
  }

  append(payload, ts = Date.now()) {
    const prev = this.head;
    const seq = prev.seq + 1;
    const entry = { seq, prevHash: prev.hash, ts, payload };
    entry.hash = entryHash(seq, prev.hash, ts, payload);
    this.entries.push(entry);
    return entry;
  }

  // Re-verify every hash and sequence link from genesis.
  verify() {
    let prev = null;
    for (const e of this.entries) {
      if (e.seq !== (prev ? prev.seq + 1 : 0)) return { ok: false, at: e.seq, reason: 'seq_gap' };
      if (!prev && e.prevHash !== '0'.repeat(64))
        return { ok: false, at: e.seq, reason: 'bad_genesis_prev' };
      if (prev && e.prevHash !== prev.hash)
        return { ok: false, at: e.seq, reason: 'prev_hash_mismatch' };
      const expected = entryHash(e.seq, e.prevHash, e.ts, e.payload);
      if (e.hash !== expected) return { ok: false, at: e.seq, reason: 'hash_mismatch' };
      prev = e;
    }
    return { ok: true, length: this.entries.length, head: prev.hash, chainId: this.chainId };
  }

  since(seq) {
    return this.entries.filter((e) => e.seq > seq);
  }
}

module.exports = { HashChain, entryHash, canonical, sha256 };