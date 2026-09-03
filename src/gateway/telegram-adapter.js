'use strict';
// D2 — outbound Telegram notification adapter (wave D, first real integration).
//
// WHY THIS FILE EXISTS AS A STANDALONE MODULE
// The integration registry (src/gateway/adapters.js) stores secrets as
// SHA-256 hashes + length + fingerprint ONLY — the raw token value is never
// persisted to disk and never reconstructible from the registry. That
// invariant is enforced by design; the gateway never reads a stored secret
// back out. For Telegram that means the bot token used to CALL the Bot API
// must come from the runtime environment, not from the registry:
//
//   • env TG_TELEGRAM_TOKEN — the only accepted source of an outbound token
//
// The "bot" carried in the registry is a config-level botRef (string name)
// used for routing / display, not a credential.
//
// PUBLIC SURFACE
// sendNotification({chatId, text, token}) → {ok, status, description?}
//   • chatId: required, string|number coerced to string
//   • text:   required string, 1..4096 chars (Telegram hard limit; we refuse
//             over-limit text rather than silently truncate — the caller
//             decides what to drop). We do NOT strip or mutate the text
//             otherwise; Markdown/HTML/special chars pass through untouched.
//   • token:  required string (the caller resolves it from env).
//   • fetchImpl: optional override (tests). Default = globalThis.fetch.
//   • timeoutMs: optional override (tests). Default 8000.
//
// On success:  {ok: true, status: 200}
// On API err:  {ok: false, status: <int>, description: '<api error text>'}
// On timeout:  {ok: false, status: 0, description: 'timeout'}
// On net err:  {ok: false, status: 0, description: 'unreachable'}
//
// URL is fixed: https://api.telegram.org/bot<token>/sendMessage — never
// derived from user input. The token only enters the URL path; it never
// appears in audit payloads, never in HTTP response bodies, never in logs.

const ENDPOINT = 'https://api.telegram.org';
const TIMEOUT_MS = 8000;
const MAX_TEXT_CHARS = 4096;

function badRequest(msg) {
  const e = new Error(msg);
  e.code = 'bad_request';
  return e;
}

function validate({ chatId, text } = {}) {
  if (chatId === undefined || chatId === null || chatId === '') {
    throw badRequest('chatId required');
  }
  if (typeof text !== 'string' || text.length < 1) {
    throw badRequest('text required (1..4096 chars)');
  }
  if (text.length > MAX_TEXT_CHARS) {
    throw badRequest(`text too long (max ${MAX_TEXT_CHARS} chars, got ${text.length})`);
  }
  // token presence is a separate check at the call site (env contract)
}

function resolveToken(token) {
  if (typeof token === 'string' && token.length > 0) return token;
  if (typeof process !== 'undefined' && process.env && process.env.TG_TELEGRAM_TOKEN) {
    return process.env.TG_TELEGRAM_TOKEN;
  }
  return null;
}

function telegramAdapter({
  fetch: fetchImpl = null,
  endpoint = ENDPOINT,
  timeoutMs = TIMEOUT_MS,
  now = () => Date.now(),
} = {}) {
  const fetchFn = fetchImpl || globalThis.fetch;

  async function sendNotification({ chatId, text, token } = {}) {
    validate({ chatId, text });
    const tk = resolveToken(token);
    if (!tk) {
      const e = new Error('telegram token not configured (set TG_TELEGRAM_TOKEN)');
      e.code = 'not_configured';
      throw e;
    }

    // chatId coerced to string — Telegram accepts both numeric and "@name"
    const url = `${endpoint}/bot${tk}/sendMessage`;
    const body = JSON.stringify({
      chat_id: String(chatId),
      text,
    });

    let r;
    try {
      r = await fetchFn(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body,
        redirect: 'manual',
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (e) {
      if (e && (e.name === 'TimeoutError' || e.name === 'AbortError')) {
        return { ok: false, status: 0, description: 'timeout' };
      }
      return { ok: false, status: 0, description: 'unreachable' };
    }

    // Telegram returns a JSON envelope: {ok: boolean, result?, description?, error_code?}
    // We translate that into the same shape as the webhook probe for consistency.
    let payload = null;
    try { payload = await r.json(); } catch { /* not json; fall through to status-only */ }

    if (r.status >= 200 && r.status < 300 && payload && payload.ok === true) {
      return { ok: true, status: r.status };
    }
    // redirect:'manual' surfaces a 3xx as the first hop — never chase.
    if (r.status >= 300 && r.status < 400) {
      return { ok: false, status: r.status, description: 'redirect_refused' };
    }
    const description = (payload && (payload.description || payload.error_code)) || `http_${r.status}`;
    return { ok: false, status: r.status, description: String(description) };
  }

  return { sendNotification, validate, MAX_TEXT_CHARS, ENDPOINT, TIMEOUT_MS };
}

module.exports = {
  telegramAdapter,
  validate,
  resolveToken,
  MAX_TEXT_CHARS,
  TIMEOUT_MS,
  ENDPOINT,
};
