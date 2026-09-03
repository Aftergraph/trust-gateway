'use strict';
// FS-A2 mount: POST /v2/chat/llm/user — user-gated variant of /v2/chat/llm.
//
// Identity resolution: gw._currentUser(req) first (FS-A1 session user, with
// {id, role, botGrants:[{bot, role}]}); if the hook is absent or returns
// null, fall back to bearer — and the bearer path DELEGATES to the
// /v2/chat/llm mount verbatim (behavior unchanged by construction, zero
// duplicated logic).
//
// User path adds three gates on top of the same governed brain:
//   1. botGrants enforcement — the acting bot must be granted to the user,
//      else 403 {error:'bot_not_granted'} (audited: chat_user_denied).
//   2. session namespacing — the planner session becomes
//      `u_<userId>:<session>` so user-bound turns live in their own sessions
//      and /h (transparency index) shows them separately from bot sessions.
//   3. rate limit — 30 requests per user per rolling 60s window; over the
//      limit → 429 with a Retry-After header (no audit row: rate limiting is
//      infrastructure, not a governance decision).
//
// The chat itself is NOT duplicated: the same getBrain(gw).propose used by
// mounts/22-chat-llm.js runs the turn (policy classification, approvals and
// cost/credit handling included). Audit rows emitted here: chat_user_denied
// {userId, bot}, chat_user_ok {userId, session} — never message text.

const { send } = require('../server');
const { getBrain } = require('../llm-brain');
const { estimateChat, LOCAL_LIMIT } = require('../llm-cost');
const { canUse, firstGrantedBot } = require('../user-access');
const bearerChatLlm = require('./22-chat-llm.js');

const WINDOW_MS = 60 * 1000;
const WINDOW_MAX = 30;

// Per-gateway buckets (WeakMap so tests can spin up isolated gateways).
const buckets = new WeakMap(); // gw -> Map(userId -> number[] timestamps)

function rateCheck(gw, userId) {
  let perGw = buckets.get(gw);
  if (!perGw) { perGw = new Map(); buckets.set(gw, perGw); }
  const now = gw.now();
  const stamps = (perGw.get(userId) || []).filter((t) => now - t < WINDOW_MS);
  if (stamps.length >= WINDOW_MAX) {
    perGw.set(userId, stamps); // keep pruned list; no new slot granted
    const retryAfter = Math.max(1, Math.ceil((stamps[0] + WINDOW_MS - now) / 1000));
    return { ok: false, retryAfter };
  }
  stamps.push(now);
  perGw.set(userId, stamps);
  return { ok: true };
}

module.exports = {
  name: 'chat-llm-user',
  method: 'POST',
  path: '/v2/chat/llm/user',
  // In-handler identity (not 'bearer'): session users need no bearer token.
  auth: 'none',
  handle: async (gw, req, res) => {
    const user = typeof gw._currentUser === 'function' ? gw._currentUser(req) : null;
    if (!user) {
      // ── bearer fallback: identical behavior to POST /v2/chat/llm ──
      const bot = gw._auth(req);
      if (!bot) {
        gw._audit({ type: 'auth_rejected', path: '/v2/chat/llm/user' });
        return send(res, 401, { error: 'unauthorized' });
      }
      return bearerChatLlm.handle(gw, req, res);
    }

    // ── user path ──
    let raw = '';
    req.on('data', (c) => { raw += c; if (raw.length > 64 * 1024) req.destroy(); });
    await new Promise((r) => req.on('end', r));
    let body;
    try { body = JSON.parse(raw || '{}'); } catch { return send(res, 400, { error: 'invalid_json' }); }
    const { session, message } = body || {};
    if (typeof session !== 'string' || session.length < 1 || session.length > 64) return send(res, 400, { error: 'session_required' });
    if (typeof message !== 'string' || message.length < 1 || message.length > 4000) return send(res, 400, { error: 'message_required' });

    // Gate 1: botGrants. Explicit body.bot wins; otherwise the user's first
    // granted bot is the default persona. No grant → 403, no brain call.
    const requested = typeof body.bot === 'string' && body.bot ? body.bot : null;
    const bot = requested || firstGrantedBot(user);
    if (!bot || !canUse(user, bot)) {
      gw._audit({ type: 'chat_user_denied', userId: user.id, bot: bot || '' });
      return send(res, 403, { error: 'bot_not_granted', bot: bot || '' });
    }

    // Gate 2: 30/min sliding window per user (before any brain work).
    const rl = rateCheck(gw, String(user.id));
    if (!rl.ok) {
      res.writeHead(429, {
        'content-type': 'application/json; charset=utf-8',
        'retry-after': String(rl.retryAfter),
      });
      return res.end(JSON.stringify({ error: 'rate_limited', retryAfter: rl.retryAfter }));
    }

    // Gate 3: namespaced planner session — user-bound turns are visible as
    // their own sessions in /h.
    const nsSession = 'u_' + String(user.id) + ':' + session;
    const brain = getBrain(gw);

    // Cost/credit preview, same as /v2/chat/llm (F4): local limit first,
    // upstream 402 → credits_exhausted shape, never a generic 5xx.
    const messages = brain.messagesForPropose(nsSession, message);
    const est = estimateChat({ messages, model: brain.cfg.model });
    if (est.promptTokens > LOCAL_LIMIT) {
      return send(res, 400, {
        error: 'context_too_large',
        promptTokens: est.promptTokens,
        limit: LOCAL_LIMIT,
        suggest: 'shorten or summarize',
      });
    }

    try {
      const out = await brain.propose(message, { session: nsSession, bot });
      gw._audit({ type: 'chat_user_ok', userId: user.id, session: nsSession });
      return send(res, 200, out);
    } catch (e) {
      if (e.code === 'llm_credits_exhausted') {
        gw._audit({
          type: 'cost_402',
          provider: brain.cfg.model || 'remote',
          status: 402,
          requested: est.promptTokens,
          max: LOCAL_LIMIT,
        });
        return send(res, 402, {
          promptTokens: est.promptTokens,
          totalTokens: est.totalTokens,
          maxTokensAllowed: LOCAL_LIMIT,
          model: brain.cfg.model || '',
          estCost: null,
          credits_exhausted: true,
          note: 'Upstream returned 402 — credit limit exhausted.',
        });
      }
      throw e;
    }
  },
};
