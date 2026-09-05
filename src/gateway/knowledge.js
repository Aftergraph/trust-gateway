'use strict';
// P2 — Knowledge library v1 (backend).
//
// Durable, queryable knowledge sources with indexing, citations and permissions.
// Distinct from memory.js (per-bot facts): knowledge is tenant/workspace-scoped,
// source-attributed, and citation-tracked (which missions/proposals used it).
//
// Source shape:
//   { id, title, kind: doc|url|note, content, tags: [],
//     visibility: 'tenant' | 'operator', created_by, created_at, updated_at,
//     citations: [{ref_type, ref_id, cited_at}], usage_count }
//
// Indexing v1: inverted token index (lowercased word -> source ids), rebuilt on
// save. Citations are recorded via cite() by other surfaces (proposals, missions).
// Fail-closed persistence (tmp+rename 0600, refuse-corrupt) — same law as memory.

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

function tokenize(text) {
  return String(text || '').toLowerCase().split(/[^a-z0-9æøåÆØÅ]+/i).filter((w) => w.length > 1);
}

class KnowledgeStore {
  constructor({ file = null, now = () => new Date().toISOString() } = {}) {
    this.file = file;
    this.now = now;
    this.sources = new Map();
    this._index = new Map(); // token -> Set(sourceId)
    this._load();
  }

  _load() {
    if (!this.file || !fs.existsSync(this.file)) return;
    let data;
    try {
      data = JSON.parse(fs.readFileSync(this.file, 'utf8'));
    } catch {
      throw new Error('knowledge: file unparseable — refusing to load (fail closed)');
    }
    if (!Array.isArray(data.sources)) throw new Error('knowledge: file must hold a sources array');
    for (const src of data.sources) this.sources.set(src.id, src);
    this._reindex();
  }

  _reindex() {
    this._index.clear();
    for (const [id, src] of this.sources) {
      for (const tok of new Set([...tokenize(src.title), ...tokenize(src.content), ...(src.tags || [])])) {
        if (!this._index.has(tok)) this._index.set(tok, new Set());
        this._index.get(tok).add(id);
      }
    }
  }

  _save() {
    if (!this.file) return;
    const tmp = this.file + '.tmp';
    const fd = fs.openSync(tmp, 'w', 0o600);
    try {
      fs.writeFileSync(fd, JSON.stringify({ sources: [...this.sources.values()] }));
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(tmp, this.file);
  }

  create({ title, kind, content, tags, visibility, created_by }) {
    if (!title || typeof title !== 'string') throw new Error('knowledge: title required');
    if (!['doc', 'url', 'note'].includes(kind)) throw new Error(`knowledge: invalid kind ${kind}`);
    if (typeof content !== 'string' || content.length === 0) throw new Error('knowledge: content required');
    if (!['tenant', 'operator'].includes(visibility || 'tenant')) {
      throw new Error(`knowledge: invalid visibility ${visibility}`);
    }
    const id = `knw_${crypto.randomBytes(6).toString('hex')}`;
    const src = {
      id, title, kind, content,
      tags: tags || [],
      visibility: visibility || 'tenant',
      created_by: created_by || null,
      created_at: this.now(),
      updated_at: this.now(),
      citations: [],
    };
    this.sources.set(id, src);
    this._reindex();
    this._save();
    return src;
  }

  get(id) { return this.sources.get(id) || null; }

  /** Search: token-index intersect (AND over query tokens), title-ranked. */
  /**
   * Semantic-ranked search v1: score = Σ TF(source,token) × IDF(token) over the
   * inverted index. Candidates are OR-matched (any query token) but scored so
   * sources matching more/rarer tokens rank higher — partial matches surface
   * instead of being dropped by AND-intersect. Pure stdlib math; no embedding API.
   */
  search(query, { limit = 10, min_score = 0.05 } = {}) {
    if (!query || typeof query !== 'string') throw new Error('knowledge: query required');
    const qtoks = [...new Set(tokenize(query.toLowerCase()))];
    if (qtoks.length === 0) return [];
    const N = Math.max(1, this.sources.size);
    const scored = [];
    for (const [id, src] of this.sources) {
      const srcTokens = new Set([...tokenize(src.title), ...tokenize(src.content), ...(src.tags || [])]);
      let score = 0;
      for (const tok of qtoks) {
        if (!srcTokens.has(tok)) continue;
        const df = (this._index.get(tok) || new Set()).size;
        const idf = Math.log((N + 1) / (df + 1)) + 1;
        const tf = tokenize(src.content).filter((t) => t === tok).length
          + tokenize(src.title).filter((t) => t === tok).length * 2;
        score += tf * idf;
      }
      if (score >= min_score) scored.push({ id, score });
    }
    return scored
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
      .map((x) => ({ ...this.sources.get(x.id), score: Number(x.score.toFixed(4)) }));
  }

  /** Citation: another surface (proposal/mission/project) used this source. */
  cite(id, { ref_type, ref_id }) {
    const src = this.sources.get(id);
    if (!src) throw new Error(`knowledge: unknown id ${id}`);
    if (!ref_type || !ref_id) throw new Error('knowledge: ref_type + ref_id required');
    src.citations.push({ ref_type, ref_id, cited_at: this.now() });
    src.updated_at = this.now();
    this._save();
    return src;
  }

  remove(id) {
    const src = this.sources.get(id);
    if (!src) return false;
    this.sources.delete(id);
    this._reindex();
    this._save();
    return true;
  }
}

module.exports = { KnowledgeStore, tokenize };
