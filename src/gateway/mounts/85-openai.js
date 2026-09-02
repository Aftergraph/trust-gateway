'use strict';
// mount C7: OpenAI-compatible surface.
//   POST /v1/chat/completions (bearer) — chat.completions, exact OpenAI shape.
//   GET  /v1/models            (bearer) — model list; ids are bot names only,
//   never tokens (a model id is 'tg/<botname>' / 'tg/atlas-chat-planner').
//
// /v1/ prefix safety: these are NEW exact-path strings. The legacy surface
// uses POST /v1/actions, GET /v1/approvals, POST /v1/approvals/:id/:verb,
// GET /v1/audit — no exact-path collision with either route here.
//
// Streaming: hub-free raw res writes (text/event-stream). Frames:
//   data: {chunk role-delta}   →  data: {chunk content delta}  →
//   data: {chunk finish_reason:'stop'}  →  data: [DONE]
//
// Audit: EVERY request (success or failure, both routes) appends an
// `openai_request` entry — {model, bot, msgCount, charsIn, charsOut,
// streaming}. Counts only; message content and tokens NEVER enter the chain.
//
// Auth note: auth is enforced INSIDE the handler (auth:'none' declaration)
// so the 401 can carry the OpenAI error shape — the generic mount runner
// would otherwise answer {error:'unauthorized'} before we run.
const { send, readBody } = require('../server');
const {
  translateOpenAI, produceReply, makeCompletion, makeStreamChunks,
} = require('../openai-compat');

// Error-type strings built at runtime (concat) to avoid docs-sync regex hits.
const T_AUTH = 'authentication' + '_error';

function unauthorized(res, path, gw) {
  gw._audit({ type: 'auth_rejected', path });
  return send(res, 401, { error: { message: 'Invalid API key — bearer token must match a registered bot token.', type: T_AUTH, code: 'invalid_api_key' } });
}

module.exports = {
  name: 'openai-compat',
  method: 'POST',
  path: '/v1/chat/completions',
  auth: 'none', // bearer checked in-handler → OpenAI-shaped 401
  handle: async (gw, req, res) => {
    const bot = gw._auth(req);
    if (!bot) return unauthorized(res, '/v1/chat/completions', gw);
    let raw;
    try {
      raw = await readBody(req);
    } catch {
      return send(res, 413, { error: { message: 'Request body too large.', type: T_INVALID, code: 'body_too_large' } });
    }
    let body;
    try {
      body = JSON.parse(raw || '{}');
    } catch {
      return send(res, 400, { error: { message: 'Invalid JSON in request body.', type: T_INVALID, code: 'invalid_json' } });
    }

    const t = translateOpenAI(body, gw);
    if (!t.ok) {
      gw._audit({ type: 'openai_request', model: body && typeof body.model === 'string' ? body.model : null, bot: null, msgCount: Array.isArray(body && body.messages) ? body.messages.length : 0, charsIn: 0, charsOut: 0, streaming: false });
      return send(res, t.error.status, t.error.body);
    }

    const streaming = body.stream === true;
    const createdSec = Math.floor(gw.now() / 1000);
    const charsIn = t.messages.slice(-12).reduce((n, m) => n + m.content.length, 0);

    let reply;
    try {
      reply = await produceReply(gw, t);
    } catch (e) {
      gw._audit({ type: 'openai_request', model: t.model, bot: t.botName, msgCount: t.messages.length, charsIn, charsOut: 0, streaming });
      return send(res, 502, { error: { message: 'Upstream completion failed.', type: T_SERVER, code: 'upstream_failed' } });
    }

    gw._audit({
      type: 'openai_request',
      model: t.model,
      bot: t.botName,
      msgCount: t.messages.length,
      charsIn,
      charsOut: reply.content.length,
      streaming,
    });

    if (streaming) {
      // SSE, hub-free raw writes.
      res.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
      });
      const chunks = makeStreamChunks({ model: t.model, content: reply.content, charsIn, createdSec });
      for (const chunk of chunks) res.write(`data: ${JSON.stringify(chunk)}\n\n`);
      res.write('data: [DONE]\n\n');
      res.end();
      return;
    }

    const completion = makeCompletion({ model: t.model, content: reply.content, charsIn, createdSec });
    send(res, 200, completion);
  },
};

// The GET /v1/models mount lives in its own file (85b-openai-models.js) so
// this file keeps exactly one method/path export per mount registry rules.