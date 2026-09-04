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
    // Normalize through JSON round-trip BEFORE hashing: the hash must be
    // reproducible from the STORED representation (undefined-valued keys
    // vanish in JSON.stringify — hashing the pre-roundtrip object made
    // reloaded chains fail verification). E2E-caught bug, 2026-09-02.
    const rt = payload === undefined ? null : JSON.parse(JSON.stringify(payload));
    const entry = { seq, prevHash: prev.hash, ts, payload: rt };
    entry.hash = entryHash(seq, prev.hash, ts, rt);
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

  // since(seq, opts?) — paged read after `seq`.
  // opts: { limit?: number = 500, cursor?: number }
  // Returns { entries, nextSince }: nextSince is the seq to pass on the next
  // call (the seq of the last entry returned), or null if the page was
  // complete. Callers should keep paging until nextSince is null.
  // Backward-compatible note: existing callers passing only `seq` get a
  // {entries, nextSince:null} envelope (callers that still want an array
  // must read .entries).
  since(seq, opts) {
    const tail = this.entries.filter((e) => e.seq > seq);
    const o = opts || {};
    const entries = o.limit == null
      ? tail
      : tail.slice(0, Math.max(0, Math.floor(o.limit)));
    const nextSince = entries.length === 0 || entries.length === tail.length
      ? null
      : entries[entries.length - 1].seq;
    return { entries, nextSince };
  }
  // Rebuild from persisted entries; verifies the whole chain. Throws on any
  // tampering, gap, or missing genesis (fail closed).
  static fromEntries(parsed) {
    if (!Array.isArray(parsed) || parsed.length === 0) throw new Error('fromEntries: empty entries');
    const g = parsed[0];
    if (!g || g.seq !== 0 || !g.payload || g.payload.type !== 'genesis')
      throw new Error('fromEntries: invalid genesis entry');
    const c = new HashChain({ chainId: g.payload.chainId, genesisTs: g.ts });
    c.entries = parsed;
    const v = c.verify();
    if (!v.ok) throw new Error(`fromEntries: audit chain invalid at seq ${v.at} (${v.reason}) — refusing to load`);
    return c;
  }
}

module.exports = { HashChain, entryHash, canonical, sha256 };