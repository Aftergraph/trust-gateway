'use strict';
// A1 mount: POST /v2/rooms/:id/ask — "spørg hjernen" i rooms-tråden.
//
// Governs the LLM turn through the SAME brain as /v2/chat/llm (getBrain(gw)
// → propose → classify/decide → approvals). The question and the answer are
// both appended to the room transcript as A2A envelopes:
//   { from: <bot>, kind: 'message',    body: <question> }
//   { from: <bot>, kind: 'assistant',  body: <reply>, proposal?, fallback? }
//
// Session is room-namespaced (`room_<roomId>`) so each room keeps its own
// brain history. Fail-closed: unknown room 404, non-member 403, empty/oversized
// message 400. Brain not configured → fallback envelope (deterministic reply),
// never 5xx. Audit: room_ask {roomId, bot, fallback} — never message text.

const { send, readBody } = require('../server');
const { getRoomStore } = require('../groups');
const { getBrain } = require('../llm-brain');

const PATH_RE = /^\/v2\/rooms\/([^/]+)\/ask$/;

module.exports = {
  name: 'rooms-ask',
  method: 'POST',
  path: PATH_RE,
  auth: 'bearer',
  handle: async (gw, req, res, ctx) => {
    const m = (req.url || '').match(PATH_RE);
    const roomId = m ? decodeURIComponent(m[1]) : null;
    if (!roomId) return send(res, 400, { error: 'bad_path' });

    let raw = '';
    req.on('data', (c) => { raw += c; if (raw.length > 64 * 1024) req.destroy(); });
    await new Promise((r) => req.on('end', r));
    let body;
    try { body = JSON.parse(raw || '{}'); } catch { return send(res, 400, { error: 'invalid_json' }); }
    const message = typeof body.message === 'string' ? body.message.trim() : '';
    if (!message) return send(res, 400, { error: 'message_required' });
    if (message.length > 4000) return send(res, 400, { error: 'message_too_long' });

    const bot = ctx.bot && ctx.bot.name;
    const store = getRoomStore(gw);
    const room = store.get(roomId);
    if (!room) return send(res, 404, { error: 'not_found' });
    if (!bot || !room.members.bots.includes(bot)) {
      return send(res, 403, { error: 'not_member' });
    }

    // 1. Post the question as the acting bot's own message envelope (replyTo hvis givet).
    const replyTo = typeof body.replyTo === 'string' && body.replyTo ? body.replyTo : null;
    const q = await store.deliver(roomId, { from: bot, kind: 'message', body: message, replyTo });
    if (!q.ok) {
      if (q.error === 'not_found') return send(res, 404, { error: 'not_found' });
      return send(res, 400, { error: q.error });
    }

    // 2. Run the governed turn — same brain, same approvals.
    const brain = getBrain(gw);
    const session = `room_${roomId}`;
    let reply, proposal = null, fallback = false;
    try {
      const out = await brain.propose(message, { session, bot });
      reply = typeof out.reply === 'string' ? out.reply : '';
      proposal = out.proposal || null;
      fallback = out.fallback === true;
    } catch (e) {
      if (e && e.code === 'llm_not_configured') {
        fallback = true;
        reply = 'hjernen er ikke konfigureret (TG_LLM_KEY/TG_LLM_MODEL mangler) — deterministisk tilstand.';
      } else {
        fallback = true;
        reply = `hjernen fejlede: ${(e && e.code) || 'unknown'}`;
      }
    }

    // 3. Append the assistant envelope (additive kind) with proposal + fallback flag.
    const a = await store.deliver(roomId, {
      from: bot,
      kind: 'assistant',
      body: reply,
      replyTo,
      extra: { ...(proposal ? { proposal } : {}), ...(fallback ? { fallback: true } : {}) },
    });
    if (!a.ok) return send(res, 400, { error: a.error });

    gw._audit({ type: 'room_ask', roomId, bot, fallback });
    send(res, 200, { ok: true, reply, ...(proposal ? { proposal } : {}), ...(fallback ? { fallback: true } : {}), messageId: a.message && a.message.id });
  },
};
