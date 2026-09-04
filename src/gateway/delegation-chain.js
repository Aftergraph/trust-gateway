'use strict';
// P2 — DelegationChain store (multi-agent A2A chain tracking).
//
// Records A2A delegation edges between messages in rooms and supports
// chain/tree/verify queries. Pure domain: no I/O, no side effects.
//
// Design:
//   - Each edge is { parentMsgId, childMsgId, kind, from, roomId }.
//   - A root message has parentMsgId = null.
//   - chain(msgId) returns the ordered path from root → msgId (breadcrumb).
//   - tree(roomId) returns the full delegation tree for a room.
//   - verify(msgId) checks the chain is unbroken (all parent refs resolve).
//
// ponytail: O(n) scan per query — fine for room-sized graphs (<10k edges).
// Upgrade to adjacency-list indexes if rooms exceed that.

class DelegationChain {
  constructor() {
    /** @type {Map<string, {parentMsgId: string|null, childMsgId: string, kind: string, from: string, roomId: string}>} */
    this._edges = new Map(); // childMsgId → edge
  }

  /**
   * Record a delegation edge.
   * @param {string|null} parentMsgId — null for root messages
   * @param {string} childMsgId — must be non-empty
   * @param {{kind: string, from: string}} meta
   * @param {string} [roomId='default'] — scopes tree queries
   */
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

  /**
   * Return the ordered delegation chain from root → msgId, or null if unknown.
   * @param {string} msgId
   * @returns {{msgId: string, kind: string, from: string}[]|null}
   */
  chain(msgId) {
    const edge = this._edges.get(msgId);
    if (!edge) return null;

    const path = [];
    let current = msgId;
    while (current) {
      const e = this._edges.get(current);
      if (!e) break; // orphan — stop but return what we have
      path.unshift({ msgId: e.childMsgId, kind: e.kind, from: e.from });
      current = e.parentMsgId;
    }
    return path;
  }

  /**
   * Return the delegation tree for a room, or null if no edges.
   * @param {string} roomId
   * @returns {{msgId: string, kind: string, from: string, children: Array}|null}
   */
  tree(roomId) {
    // Find all edges for this room
    const roomEdges = [];
    for (const e of this._edges.values()) {
      if (e.roomId === roomId) roomEdges.push(e);
    }
    if (roomEdges.length === 0) return null;

    // Build adjacency: parentMsgId → [child edges]
    const children = new Map();
    let roots = [];
    for (const e of roomEdges) {
      if (!children.has(e.parentMsgId)) children.set(e.parentMsgId, []);
      children.get(e.parentMsgId).push(e);
      if (e.parentMsgId === null) roots.push(e);
    }

    // Build tree recursively
    function build(node) {
      const kids = (children.get(node.childMsgId) || []).map(build);
      return { msgId: node.childMsgId, kind: node.kind, from: node.from, children: kids };
    }

    // If multiple roots, return a synthetic root
    if (roots.length === 1) return build(roots[0]);
    return {
      msgId: '(multi-root)',
      kind: 'room',
      from: '',
      children: roots.map(build),
    };
  }

  /**
   * Verify the chain from root → msgId is unbroken.
   * @param {string} msgId
   * @returns {boolean|null} — null if msgId unknown, false if broken
   */
  verify(msgId) {
    const edge = this._edges.get(msgId);
    if (!edge) return null;

    let current = msgId;
    while (current) {
      const e = this._edges.get(current);
      if (!e) return false; // broken — parent ref doesn't resolve
      if (e.parentMsgId === null) return true; // reached root
      current = e.parentMsgId;
    }
    return false;
  }
}

module.exports = { DelegationChain };
