'use strict';
// mount: POST /v2/chat/llm — LLM brain chat (W1). Governed like /v2/chat:
// the model may only PROPOSE actions; proposals go through classify/decide
// and approvals, never direct execution. When TG_LLM_* is unset the request
// still succeeds with a clean {fallback:true, reply} — no 5xx, no crash.
// F4: cost/credit preview gate before upstream call; 402 → credits_exhausted
// (never a generic 5xx).
const { getBrain } = require('../llm-brain');
const { estimateChat, LOCAL_LIMIT } = require('../llm-cost');
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

    // F4: local cost/credit preview — gate before upstream call.
    const messages = brain.messagesForPropose(session, message);
    const est = estimateChat({ messages, model: brain.cfg.model });
    if (est.promptTokens > LOCAL_LIMIT) {
      return send(res, 400, {
        error: 'context_too_large',
        promptTokens: est.promptTokens,
        limit: LOCAL_LIMIT,
        suggest: 'shorten or summarize',
      });
    }

    // F4: upstream 402 → credits_exhausted shape, never generic 5xx.
    try {
      const out = await brain.propose(message, { session, bot: typeof bot === 'string' ? bot : undefined });
      send(res, 200, out);
    } catch (e) {
      if (e.code === 'llm_credits_exhausted') {
        gw._audit({
          type: 'cost_402',
          provider: brain.cfg.model || 'remote',
          status: 402,
          requested: est.promptTokens,
          max: LOCAL_LIMIT,
        });
        send(res, 402, {
          promptTokens: est.promptTokens,
          totalTokens: est.totalTokens,
          maxTokensAllowed: LOCAL_LIMIT,
          model: brain.cfg.model || '',
          estCost: null,
          credits_exhausted: true,
          note: 'Upstream returned 402 — credit limit exhausted.',
        });
      } else {
        throw e;
      }
    }
  },
};