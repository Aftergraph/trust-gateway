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
    fs.writeFileSync(tmp, JSON.stringify({ sources: [...this.sources.values()] }), { mode: 0o600 });
    if (process.platform !== 'win32') { try { fs.chmodSync(tmp, 0o600); } catch { } }
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
  search(query, { limit = 10 } = {}) {
    if (!query || typeof query !== 'string') throw new Error('knowledge: query required');
    const toks = new Set(tokenize(query.toLowerCase()));
    if (toks.size === 0) return [];
    let candidates = null;
    for (const tok of toks) {
      const ids = this._index.get(tok) || new Set();
      candidates = candidates === null
        ? new Set(ids)
        : new Set([...candidates].filter((x) => ids.has(x)));
      if (candidates.size === 0) break;
    }
    return [...candidates]
      .map((id) => this.sources.get(id))
      .filter(Boolean)
      .sort((a, b) => {
        const as = tokenize(a.title).filter((t) => toks.has(t)).length;
        const bs = tokenize(b.title).filter((t) => toks.has(t)).length;
        return bs - as;
      })
      .slice(0, limit);
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
