'use strict';
// P2 — DelegationChain store (multi-agent A2A chain tracking).
//
// Records A2A delegation edges between messages in rooms and supports
// chain/tree/verify queries. The base class is pure in-memory domain logic;
// DurableDelegationChain adds fail-closed JSON persistence.
//
// ponytail: O(n) scan per query — fine for room-sized graphs (<10k edges).
// Upgrade to adjacency-list indexes if rooms exceed that.

const fs = require('node:fs');
const path = require('node:path');

class DelegationChain {
  constructor() {
    this._edges = new Map(); // childMsgId → edge
  }

  record(parentMsgId, childMsgId, { kind, from }, roomId = 'default') {
    if (typeof childMsgId !== 'string' || !childMsgId) {
      throw new Error('DelegationChain: msgId must be a non-empty string');
    }
    if (typeof kind !== 'string' || !kind) {
      throw new Error('DelegationChain: kind must be a non-empty string');
    }
    this._edges.set(childMsgId, {
      parentMsgId: parentMsgId ?? null,
      childMsgId,
      kind,
      from: from ?? 'unknown',
      roomId,
    });
  }

  chain(msgId) {
    const edge = this._edges.get(msgId);
    if (!edge) return null;
    const path = [];
    let current = msgId;
    const seen = new Set();
    while (current) {
      if (seen.has(current)) return path;
      seen.add(current);
      const e = this._edges.get(current);
      if (!e) break;
      path.unshift({ msgId: e.childMsgId, kind: e.kind, from: e.from });
      current = e.parentMsgId;
    }
    return path;
  }

  tree(roomId) {
    const roomEdges = [...this._edges.values()].filter((e) => e.roomId === roomId);
    if (roomEdges.length === 0) return null;
    const children = new Map();
    const roots = [];
    for (const e of roomEdges) {
      if (!children.has(e.parentMsgId)) children.set(e.parentMsgId, []);
      children.get(e.parentMsgId).push(e);
      if (e.parentMsgId === null) roots.push(e);
    }
    const build = (node, seen = new Set()) => {
      if (seen.has(node.childMsgId)) return { msgId: node.childMsgId, kind: node.kind, from: node.from, children: [] };
      const next = new Set(seen).add(node.childMsgId);
      return {
        msgId: node.childMsgId,
        kind: node.kind,
        from: node.from,
        children: (children.get(node.childMsgId) || []).map((child) => build(child, next)),
      };
    };
    if (roots.length === 1) return build(roots[0]);
    return { msgId: '(multi-root)', kind: 'room', from: '', children: roots.map((root) => build(root)) };
  }

  verify(msgId) {
    if (!this._edges.has(msgId)) return null;
    let current = msgId;
    const seen = new Set();
    while (current) {
      if (seen.has(current)) return false;
      seen.add(current);
      const edge = this._edges.get(current);
      if (!edge) return false;
      if (edge.parentMsgId === null) return true;
      current = edge.parentMsgId;
    }
    return false;
  }
}

class DurableDelegationChain extends DelegationChain {
  constructor({ file } = {}) {
    if (typeof file !== 'string' || !file) throw new Error('DelegationChain: file required');
    super();
    this.file = path.resolve(file);
    if (fs.existsSync(this.file)) this._load();
  }

  _load() {
    let data;
    try {
      data = JSON.parse(fs.readFileSync(this.file, 'utf8'));
    } catch {
      throw new Error('delegation-chain: file unparseable — refusing to load');
    }
    if (!data || data.version !== 1 || !Array.isArray(data.edges)) {
      throw new Error('delegation-chain: invalid state shape');
    }
    for (const edge of data.edges) {
      if (!edge || typeof edge.childMsgId !== 'string' || !edge.childMsgId
        || (edge.parentMsgId !== null && typeof edge.parentMsgId !== 'string')
        || typeof edge.kind !== 'string' || !edge.kind
        || typeof edge.from !== 'string' || typeof edge.roomId !== 'string'
        || this._edges.has(edge.childMsgId)) {
        throw new Error('delegation-chain: invalid edge');
      }
      this._edges.set(edge.childMsgId, { ...edge });
    }
  }

  _save() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    const fd = fs.openSync(tmp, 'w', 0o600);
    try {
      fs.writeFileSync(fd, JSON.stringify({ version: 1, edges: [...this._edges.values()] }) + '\n');
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(tmp, this.file);
    try { fs.chmodSync(this.file, 0o600); } catch { /* mode is set at open */ }
  }

  record(parentMsgId, childMsgId, meta, roomId = 'default') {
    super.record(parentMsgId, childMsgId, meta, roomId);
    this._save();
  }
}

module.exports = { DelegationChain, DurableDelegationChain };
