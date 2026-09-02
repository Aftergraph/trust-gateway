'use strict';
// mount: POST /v2/chat/llm/deep — multi-iteration LLM tool-call loop
// (wave D, node C1 of wave C). Builds the allowed-tools list from
// ROLE_CAPABILITIES + classify (read/write only, no wildcards expanded
// into token names), asks the model, parses its <action …/> tag, and
// runs every parsed tool through classify/decide + gw.approvals + the
// SAME executor path the rest of the platform uses (gw._run, which the
// server wires to registered executors OR the jailed dispatcher). Brain
// unset → 200 with {fallback:true, reply:'llm not configured'}. Sessions
// reuse the ChatPlanner session store (sessions live on the brain object
// via llm-brain.js; the deterministic planner has its own, but this
// endpoint shares the same per-gateway WeakMap brain so a single process
// keeps both surfaces' histories in the same Map when they use the same
// session name).
//
// Reuses the brain from llm-brain.js (setBrain/getBrain WeakMap) — never
// creates its own adapter instance. A bearer-authed request reaches the
// loop via getBrain(gw); the loop does the work.

const { getBrain } = require('../llm-brain');
const { deepTurn, FALLBACK_UNCONFIGURED } = require('../llm-loop');
const { send } = require('../server');

module.exports = {
  name: 'chat-llm-deep',
  method: 'POST',
  path: '/v2/chat/llm/deep',
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
    if (!brain || brain.configured === false) {
      return send(res, 200, { fallback: true, reply: FALLBACK_UNCONFIGURED, actions: [], iterations: 0 });
    }
    const out = await deepTurn(gw, brain, {
      session,
      message,
      bot: typeof bot === 'string' ? bot : undefined,
    });
    return send(res, 200, out);
  },
};
