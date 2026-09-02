'use strict';
// v2 mount (wave C — C3): web.fetch / web.extract convenience JSON API.
//
// Exposes a single POST /v2/web/fetch endpoint so a console/operator can
// exercise the SSRF-guarded fetch without going through a bot dispatch.
// The actual synthetic tools web.fetch:* / web.extract:* are registered
// as Gateway executors (see `executors` below), so they participate in
// the fail-closed policy pipeline (destructive class → needs_approval).
//
// Auth: bearer — only authenticated bots can trigger a fetch.
// Audit: gw._audit({type:'web_fetch', host, status, bytes}) — host ONLY.

const { send, readBody } = require('../server');
const { fetchPage, htmlToText, makeWebExecutor } = require('../webtools');

function authBearer(gw, req) {
  const h = req.headers['authorization'] || '';
  const m = /^Bearer\s+(.+)$/i.exec(h);
  if (!m) return null;
  return m[1];
}

async function handle(gw, req, res) {
  // 405 for non-POST — the convenience endpoint is write-shaped.
  if (req.method !== 'POST') {
    return send(res, 405, { error: 'method_not_allowed' });
  }
  const token = authBearer(gw, req);
  let botName = null;
  for (const [name, bot] of Object.entries(gw.bots || {})) {
    if (bot && bot.token && bot.token === token) { botName = name; break; }
  }
  if (!botName) {
    try { gw._audit({ type: 'auth_rejected', path: '/v2/web/fetch' }); } catch { /* noop */ }
    return send(res, 401, { error: 'unauthorized' });
  }
  let body = {};
  try { body = JSON.parse(await readBody(req)) || {}; }
  catch { return send(res, 400, { error: 'invalid_json' }); }
  const { url } = body;
  if (typeof url !== 'string' || url.length === 0 || !/^https?:\/\//.test(url)) {
    return send(res, 400, { error: 'bad_url' });
  }
  let fetched;
  try {
    fetched = await fetchPage(url);
  } catch (e) {
    const msg = String(e && e.message || e);
    // Audit the refusal too — visibility on SSRF hits matters.
    let host = '';
    try { host = new URL(url).hostname; } catch { /* noop */ }
    try { gw._audit({ type: 'web_fetch', bot: botName, host, status: 0, bytes: 0, error: msg }); } catch { /* noop */ }
    // Distinguish client-side badness (4xx) from network/SSRF blocks (4xx too,
    // but bad_url / scheme_not_https is a malformed request, while private_address
    // is a server-side refusal). Both are 400-class for a console UI.
    const code = (msg.startsWith('blocked:') || msg.startsWith('http_')) ? 403 : 400;
    return send(res, code, { error: msg });
  }
  // Host-only audit on success.
  let host = '';
  try { host = new URL(fetched.url).hostname; } catch { /* noop */ }
  try {
    gw._audit({
      type: 'web_fetch', bot: botName, host,
      status: fetched.status, bytes: fetched.textBytes,
    });
  } catch { /* noop */ }
  return send(res, 200, {
    url: fetched.url,
    status: fetched.status,
    title: fetched.title,
    contentType: fetched.contentType,
    textBytes: fetched.textBytes,
    truncated: !!fetched.truncated,
    text: fetched.text,
  });
}

module.exports = {
  name: 'v2-web',
  method: 'POST',
  path: '/v2/web/fetch',
  auth: 'bearer',
  handle,
  executors: [
    { re: /^web\.(fetch|extract):/, make: (gw) => makeWebExecutor({ gw }) },
  ],
};
