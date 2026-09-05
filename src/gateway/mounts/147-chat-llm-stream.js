'use strict';
// A2 mount: POST /v2/chat/llm/stream — SSE token-streaming med governed afslutning.
//
// Visning: upstream token-chunks viderestreames som `event: delta`.
// Governance: hele svaret + parsed proposal kører gennem SAMME brain.propose-
// pipeline (classify/decide + approvals) som /v2/chat/llm; `event: done` bærer
// det governed verdict (reply/proposal/fallback). Strømmen er KUN display —
// intet eksekveres fra deltas.
//
// Ikke-konfigureret brain → én done-event {fallback:true}, 200, ingen 5xx.
// Protokol: text/event-stream; blocks separeres af blank linje.

const { send } = require('../server');
const { getBrain } = require('../llm-brain');

module.exports = {
  name: 'chat-llm-stream',
  method: 'POST',
  path: '/v2/chat/llm/stream',
  auth: 'bearer',
  handle: async (gw, req, res, ctx) => {
    let raw = '';
    req.on('data', (c) => { raw += c; if (raw.length > 64 * 1024) req.destroy(); });
    await new Promise((r) => req.on('end', r));
    let body;
    try { body = JSON.parse(raw || '{}'); } catch { return send(res, 400, { error: 'invalid_json' }); }
    const { session, message, bot } = body || {};
    if (typeof session !== 'string' || session.length < 1 || session.length > 64) return send(res, 400, { error: 'session_required' });
    if (typeof message !== 'string' || message.trim().length < 1 || message.length > 4000) return send(res, 400, { error: 'message_required' });

    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    });

    const sse = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

    const brain = getBrain(gw);
    const canStream = typeof brain.chatStream === 'function';
    if (!brain.configured && !canStream) {
      sse('done', { fallback: true, reply: 'LLM brain not configured.', actions: [] });
      gw._audit({ type: 'chat_llm_stream', session, fallback: true });
      return res.end();
    }

    // Stream token-chunks (display-only). chatStream yields text pieces.
    // Governance: samme propose-rute giver det sealed verdict på done.
    try {
      if (canStream) {
        for await (const chunk of brain.chatStream(message, { session, bot })) {
          if (chunk) sse('delta', { text: String(chunk) });
        }
      }
      const out = await brain.propose(message, { session, bot });
      sse('done', {
        reply: out.reply,
        ...(out.proposal ? { proposal: out.proposal } : {}),
        ...(out.fallback ? { fallback: true } : {}),
      });
      gw._audit({ type: 'chat_llm_stream', session, fallback: out.fallback === true });
    } catch (e) {
      sse('error', { error: (e && e.code) || 'llm_stream_error' });
      gw._audit({ type: 'chat_llm_stream', session, error: (e && e.code) || 'llm_stream_error' });
    }
    res.end();
  },
};
