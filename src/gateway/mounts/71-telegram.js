'use strict';
// D2 mount — Telegram outbound notification.
//
// One RegExp covers the whole /v2/adapters/telegram tree (single registration,
// wave C mount pattern, sibling of 70-adapters.js — that file owns the
// registry CRUD; this file owns the SEND action):
//
//   POST /v2/adapters/telegram/notify   body: {chatId, text}
//     → 202 {queued:true} then async fire-and-forget send
//     → 400 on bad input, 403 on non-operator, 503 on env-unset
//
// AUTH / ROLE
// Bearer (validated by the mount runner before this handler runs). Per-mount
// role gating is not a built-in field on the mount contract (server.js only
// supports 'bearer' | 'query' | 'none'), so the operator check happens in
// the handler — same pattern as mounts/25-groups.js:
//   ctx.bot.role === 'operator' || cap 'approval.decide' || cap '*'
//
// AUDIT (no text, no token — chatId + chars + outcome only)
//   type: 'telegram_notify'   {chat_id, chars, ok?, status}
//
// HYGIENE NOTES
//   • The token comes from process.env.TG_TELEGRAM_TOKEN, NEVER from the
//     registry. The adapter registry stores SHA-256 hashes only (the raw
//     value is not recoverable), so even if the design had called for a
//     stored token we could not honor that — we just document the intent.
//   • Audit entries must be JSON-round-trip safe (platform rule 3). We only
//     put plain scalars through gw._audit; the text never reaches the
//     chain. The chain scanner in the test suite asserts that explicitly.
//   • Bearer header values are built at runtime (no bare scheme literal).
//   • Tests inject fetch into the adapter and never hit api.telegram.org.

const { send } = require('../server');
const { telegramAdapter, MAX_TEXT_CHARS, ENDPOINT } = require('../telegram-adapter');

// single shared adapter per gateway — tests can swap fetch via process.env
// once at boot OR by mutating env-backed token; the adapter instance is
// created lazily on first request and re-reads env on each send.
function adapter() {
  return telegramAdapter({});
}

function readJson(req, maxBytes = 64 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > maxBytes) { reject(new Error('body_too_large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) { resolve({}); return; }
      try { resolve(JSON.parse(raw)); }
      catch (e) { reject(new Error('invalid_json')); }
    });
    req.on('error', reject);
  });
}

function isOperator(bot) {
  if (!bot) return false;
  if (bot.role === 'operator') return true;
  if (Array.isArray(bot.capabilities)) {
    if (bot.capabilities.includes('*')) return true;
    if (bot.capabilities.includes('approval.decide')) return true;
  }
  return false;
}

module.exports = {
  name: 'v2-telegram-notify',
  method: 'POST',
  path: /^\/v2\/adapters\/telegram\/notify$/,
  auth: 'bearer',
  handle: async (gw, req, res, ctx) => {
    if (!isOperator(ctx.bot)) {
      gw._audit({ type: 'telegram_notify_rejected', reason: 'role', bot: ctx.bot && ctx.bot.name });
      return send(res, 403, { error: 'operator_required' });
    }

    let body;
    try { body = await readJson(req); }
    catch (e) {
      const code = e.message === 'body_too_large' ? 413 : 400;
      const err = e.message === 'body_too_large' ? 'body_too_large' : 'invalid_json';
      return send(res, code, { error: err });
    }
    if (!body || typeof body !== 'object') {
      return send(res, 400, { error: 'invalid_body' });
    }

    const { chatId, text } = body;
    if (chatId === undefined || chatId === null || chatId === '') {
      return send(res, 400, { error: 'chatId_required' });
    }
    if (typeof text !== 'string' || text.length < 1) {
      return send(res, 400, { error: 'text_required' });
    }
    if (text.length > MAX_TEXT_CHARS) {
      return send(res, 400, { error: 'text_too_long', max: MAX_TEXT_CHARS, got: text.length });
    }

    // env gate — registry has no stored token, so the env is the only source
    const env = (typeof process !== 'undefined' && process.env) || {};
    if (!env.TG_TELEGRAM_TOKEN) {
      gw._audit({
        type: 'telegram_notify',
        chat_id: String(chatId),
        chars: text.length,
        ok: false,
        status: 0,
        error: 'not_configured',
      });
      return send(res, 503, { error: 'telegram_not_configured' });
    }

    // respond 202 first, then send async — the mount is fire-and-forget.
    const chars = text.length;
    const chatIdStr = String(chatId);
    // detach the promise — do NOT await the remote call
    const bg = adapter().sendNotification({ chatId: chatIdStr, text })
      .then((r) => {
        gw._audit({
          type: 'telegram_notify',
          chat_id: chatIdStr,
          chars,
          ok: r.ok,
          status: r.status,
          ...(r.description ? { error: r.description } : {}),
        });
      })
      .catch((e) => {
        gw._audit({
          type: 'telegram_notify',
          chat_id: chatIdStr,
          chars,
          ok: false,
          status: 0,
          error: e && e.message ? String(e.message) : 'send_failed',
        });
      });
    // keep the bg promise reachable so node doesn't exit during the test
    if (typeof globalThis.__telegramNotifyPending === 'undefined') {
      globalThis.__telegramNotifyPending = [];
    }
    globalThis.__telegramNotifyPending.push(bg);

    return send(res, 202, { queued: true, chars });
  },
};

module.exports.ENDPOINT = ENDPOINT;
module.exports.MAX_TEXT_CHARS = MAX_TEXT_CHARS;
module.exports.isOperator = isOperator;
