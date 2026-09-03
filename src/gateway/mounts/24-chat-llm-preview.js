'use strict';
// mount: POST /v2/chat/llm/preview — F4 cost/credit preview.
//
// Bearer auth, body same shape as /v2/chat/llm ({session, message, bot}).
// Returns a local token estimate WITHOUT calling upstream. The estimate
// uses Math.ceil(chars/4) per OpenAI's rule of thumb — documented in
// src/gateway/llm-cost.js; it is NOT a guarantee and estCost is always
// null because the platform MUST NOT fabricate model prices.
const { getBrain } = require('../llm-brain');
const { estimateChat, LOCAL_LIMIT } = require('../llm-cost');
const { send } = require('../server');

module.exports = {
  name: 'chat-llm-preview',
  method: 'POST',
  path: '/v2/chat/llm/preview',
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
    const messages = brain.messagesForPropose(session, message);
    const est = estimateChat({ messages, model: brain.cfg.model });
    const willExceed = est.promptTokens > LOCAL_LIMIT;

    send(res, 200, {
      promptTokens: est.promptTokens,
      totalTokens: est.totalTokens,
      maxTokensAllowed: LOCAL_LIMIT,
      willExceed,
      model: brain.cfg.model || '',
      estCost: est.estCost,
      note: 'Token estimate is local (Math.ceil(chars/4) per OpenAI rule of thumb). Not a guarantee. estCost is null — the platform MUST NOT fabricate model prices.',
    });
  },
};