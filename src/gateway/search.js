'use strict';
// Trust Gateway v2 — audit search over the in-memory HashChain.
// When SqlChain lands (A1), this module will swap to FTS5 queries.
// For now it does substring matching over canonical payload JSON,
// which is correct for the v2 contract and zero-dep.

function searchChain(chain, q, { limit = 50 } = {}) {
  if (!chain || typeof chain.entries !== 'object') return { hits: [], error: 'no_chain' };
  if (!q || typeof q !== 'string' || q.trim().length === 0) return { hits: [] };
  const needle = q.toLowerCase();
  const hits = [];
  // Walk newest-first so operators see recent matches first.
  for (let i = chain.entries.length - 1; i >= 0 && hits.length < limit; i--) {
    const e = chain.entries[i];
    const blob = JSON.stringify(e.payload).toLowerCase();
    if (blob.includes(needle)) {
      hits.push({
        seq: e.seq,
        ts: e.ts,
        hash: e.hash,
        payload: e.payload,
      });
    }
  }
  return { hits, query: q, total: hits.length };
}

module.exports = { searchChain };
