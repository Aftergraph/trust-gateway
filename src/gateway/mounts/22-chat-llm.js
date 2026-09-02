'use strict';
// mount: POST /v2/chat/llm — LLM brain chat (W1). Governed like /v2/chat:
// the model may only PROPOSE actions; proposals go through classify/decide
// and approvals, never direct execution. When TG_LLM_* is unset the request
// still succeeds with a clean {fallback:true, reply} — no 5xx, no crash.
const { getBrain } = require('../llm-brain');
const { send } = require('../server');

module.exports = {
  name: 'chat-llm',
  method: 'POST',
  path: '/v2/chat/llm',
  auth: 'bearer',
  handle: async (gw, req, res, ctx) => {
    let raw = '';
    req.on('data', (c) => { raw += c; if (raw.length > 64 * 1024) req.destroy(); });
    await new Promise((r) => req.on('end', r));
    let body;
    try { body = JSON.parse(raw || '{}'); } catch { return send(res, 400, { error: 'invalid_json' }); }
    const { session, message, bot } = body || {};
    if (typeof session !== 'string' || session.length < 1 || session.length > 64) return send(res, 400, { error: 'session_required' });
    if (typeof message !== 'string' || message.length < 1 || message.length > 4000) return send(res, 400, { error: 'message_required' });
    const brain = getBrain(gw);
    const out = await brain.propose(message, { session, bot: typeof bot === 'string' ? bot : undefined });
    send(res, 200, out);
  },
};
