'use strict';

const { db, json, unjson, resetDb } = require('./db');

const crypto = require('crypto');

function sha256(str) {
  return crypto.createHash('sha256').update(str).digest('hex');
}

class ConversationStore {
  constructor(tenant) {
    if (typeof tenant !== 'string' || tenant.length === 0) {
      throw new Error('tenant required');
    }
    this.tenant = tenant;
  }

  /** Create a new conversation. Returns { id, title, created_at, updated_at }. */
  create(title) {
    const id = crypto.randomUUID();
    const now = Date.now();
    db.prepare(
      `INSERT INTO conversations (id, tenant, title, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?)`
    ).run(id, this.tenant, title, now, now);
    return { id, title, created_at: now, updated_at: now };
  }

  /** List all conversations for the tenant (most recent first). */
  list() {
    return db.prepare(
      `SELECT id, title, created_at, updated_at FROM conversations 
       WHERE tenant = ? ORDER BY updated_at DESC`
    ).all(this.tenant);
  }

  /** Get a single conversation by id. Returns undefined if not found or wrong tenant. */
  get(id) {
    return db.prepare(
      `SELECT id, title, created_at, updated_at FROM conversations 
       WHERE id = ? AND tenant = ?`
    ).get(id, this.tenant);
  }

  /** Append a message to a conversation. Returns { id, conversation_id, role, content, ts, payload_hash }. */
  /**
   * Append a message. Composer v1 (P1): `meta` optionally carries attachments
   * [{name, mime, size, sha256}] and mentions [agent_id] — both are part of the
   * hashed payload (tamper-evident like the rest of the message).
   */
  appendMessage(conversationId, role, content, meta = {}) {
    const msgId = crypto.randomUUID();
    const ts = Date.now();
    const cleanMeta = meta && (meta.attachments || meta.mentions) ? meta : null;
    const payload = JSON.stringify({ conversation_id: conversationId, role, content, ts, meta: cleanMeta });
    const payloadHash = sha256(payload);

    db.prepare(
      `INSERT INTO messages (id, conversation_id, role, content, ts, payload_hash)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).run(msgId, conversationId, role, content, ts, payloadHash);

    db.prepare(
      `UPDATE conversations SET updated_at = ? WHERE id = ? AND tenant = ?`
    ).run(ts, conversationId, this.tenant);

    const out = { id: msgId, conversation_id: conversationId, role, content, ts, payload_hash: payloadHash };
    if (cleanMeta) out.meta = cleanMeta;
    return out;
  }

  /**
   * Composer context-preview (P1): what the model will see next turn —
   * message tail + any pending NeedsYou + active proposals for this tenant.
   * Read-only; no side effects.
   */
  preview(conversationId, { tail = 10 } = {}) {
    const messages = this.getMessages(conversationId, 0).slice(-tail);
    return {
      conversation_id: conversationId,
      message_tail: messages,
      tail_count: messages.length,
    };
  }

  /** Get messages for a conversation, optionally since a timestamp.
   *  For SSE replay-ready: passes back { id, role, content, ts, payload_hash } for each.
   */
  getMessages(conversationId, sinceTs) {
    if (sinceTs != null) {
      return db.prepare(
        `SELECT id, role, content, ts, payload_hash FROM messages 
         WHERE conversation_id = ? AND ts > ?
         ORDER BY ts ASC`
      ).all(conversationId, sinceTs);
    }
    return db.prepare(
      `SELECT id, role, content, ts, payload_hash FROM messages 
       WHERE conversation_id = ? ORDER BY ts ASC`
    ).all(conversationId);
  }

  /** Delete a conversation and all its messages. */
  delete(id) {
    db.prepare('DELETE FROM messages WHERE conversation_id = ?').run(id);
    db.prepare('DELETE FROM conversations WHERE id = ? AND tenant = ?').run(id, this.tenant);
  }

  /** Full history replay: conversation metadata + all messages. */
  replay(id) {
    const conv = this.get(id);
    if (!conv) return null;
    const messages = this.getMessages(id);
    return { ...conv, messages };
  }
}

module.exports = { ConversationStore, sha256 };
