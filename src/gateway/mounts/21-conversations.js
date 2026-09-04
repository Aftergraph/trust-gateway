'use strict';

const { ConversationStore } = require('../conversations');
const { send } = require('../server');

module.exports = {
  name: 'conversations',
  method: '*',
  path: /^\/v2\/conversations(?:\/.*)?$/,
  auth: 'bearer',
  handle: async (gw, req, res, ctx) => {
    // Tenant scoping (FS-E1d pattern): tnt_<id>_ prefix claim on the bearer token,
    // else the main tenant. ctx.bot is the authenticated roster entry.
    const tm = /^tnt_([a-z0-9-]{3,24})_/.exec((req.headers['authorization'] || '').replace(/^Bearer\s+/i, ''));
    const tenant = tm ? tm[1] : 'main';
    const store = new ConversationStore(tenant);
    const pathname = ctx.url.pathname;
    const seg = pathname.split('/');
    
    // GET /v2/conversations - list all conversations
    if (req.method === 'GET' && seg.length === 3) {
      const conversations = store.list();
      return send(res, 200, { conversations });
    }

    // POST /v2/conversations - create a conversation
    if (req.method === 'POST' && seg.length === 3) {
      let raw = '';
      req.on('data', c => { raw += c; if (raw.length > 64 * 1024) req.destroy(); });
      await new Promise(r => req.on('end', r));
      let body;
      try { body = JSON.parse(raw || '{}'); } catch { return send(res, 400, { error: 'invalid_json' }); }
      const { title } = body || {};
      if (typeof title !== 'string' || title.length < 1) return send(res, 400, { error: 'title_required' });
      const conv = store.create(title);
      return send(res, 201, conv);
    }

    // GET /v2/conversations/:id/messages?since=T - get messages
    if (req.method === 'GET' && seg.length === 5 && seg[4] === 'messages') {
      const id = seg[3];
      const sinceParam = ctx.url.searchParams.get('since');
      const sinceTs = sinceParam != null ? parseInt(sinceParam, 10) : null;
      const messages = store.getMessages(id, sinceTs);
      return send(res, 200, { messages });
    }

    // POST /v2/conversations/:id/messages - append a message
    if (req.method === 'POST' && seg.length === 5 && seg[4] === 'messages') {
      const id = seg[3];
      let raw = '';
      req.on('data', c => { raw += c; if (raw.length > 64 * 1024) req.destroy(); });
      await new Promise(r => req.on('end', r));
      let body;
      try { body = JSON.parse(raw || '{}'); } catch { return send(res, 400, { error: 'invalid_json' }); }
      const { role, content } = body || {};
      if (typeof role !== 'string' || !['user', 'assistant'].includes(role)) return send(res, 400, { error: 'role_required' });
      if (typeof content !== 'string' || content.length < 1) return send(res, 400, { error: 'content_required' });
      const msg = store.appendMessage(id, role, content);
      return send(res, 201, msg);
    }

    // GET /v2/conversations/:id - get a single conversation
    if (req.method === 'GET' && seg.length === 4) {
      const id = seg[3];
      const conv = store.get(id);
      if (!conv) return send(res, 404, { error: 'not_found' });
      return send(res, 200, conv);
    }

    // DELETE /v2/conversations/:id - delete a conversation
    if (req.method === 'DELETE' && seg.length === 4) {
      const id = seg[3];
      const conv = store.get(id);
      if (!conv) return send(res, 404, { error: 'not_found' });
      store.delete(id);
      return send(res, 200, { deleted: true });
    }

    return send(res, 404, { error: 'not_found' });
  },
};
