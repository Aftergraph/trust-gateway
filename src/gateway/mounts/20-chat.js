'use strict';
// mount: POST /v2/chat — governed chat proposals (ChatPlanner).
const { getPlanner } = require('../chat-singleton');
const { send } = require('../server');

module.exports = {
  name: 'chat',
  method: 'POST',
  path: '/v2/chat',
  auth: 'bearer',
  handle: async (gw, req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; if (raw.length > 64 * 1024) req.destroy(); });
    await new Promise((r) => req.on('end', r));
    let body;
    try { body = JSON.parse(raw || '{}'); } catch { return send(res, 400, { error: 'invalid_json' }); }
    const { session, message, bot } = body || {};
    if (typeof session !== 'string' || session.length < 1 || session.length > 64) return send(res, 400, { error: 'session_required' });
    if (typeof message !== 'string' || message.length < 1 || message.length > 4000) return send(res, 400, { error: 'message_required' });
    const planner = getPlanner(gw);
    const out = await planner.plan(session, message, typeof bot === 'string' ? bot : undefined);
    send(res, 200, out);
  },
};