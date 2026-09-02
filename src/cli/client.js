'use strict';
// W7 CLI/TUI — client layer. Reuses the GatewayClient SDK (src/gateway/client)
// and extends it with the v2 endpoints the CLI needs: /healthz, /v2/stats,
// /v2/search (query-token auth), /v2/chat. Nothing here reimplements HTTP:
// every call goes through GatewayClient._request.

const { GatewayClient } = require('../gateway/client');

class CliClient extends GatewayClient {
  /** GET /healthz — unauthenticated liveness + chain snapshot. */
  health() {
    return this._request('GET', '/healthz');
  }

  /** GET /v2/stats — operator summary (bearer auth). */
  stats() {
    return this._request('GET', '/v2/stats');
  }

  /**
   * GET /v2/search?q=...&limit=...&token=...
   * The search mount uses query-token auth (browser EventSource constraint),
   * so the token rides in the query string in addition to the bearer header.
   */
  search(q, limit) {
    const params = new URLSearchParams({ q: String(q) });
    if (limit) params.set('limit', String(limit));
    params.set('token', this.token);
    return this._request('GET', `/v2/search?${params.toString()}`);
  }

  /** POST /v2/chat {session, message, bot?} -> {reply, actions[]} */
  chat(message, { session = 'cli', bot } = {}) {
    const body = { session: String(session), message: String(message) };
    if (bot) body.bot = String(bot);
    return this._request('POST', '/v2/chat', body);
  }
}

/**
 * Resolve connection config from CLI flags + environment.
 * TG_URL / TG_TOKEN are the contract env vars; flags win over env.
 * Returns { client } or { error } (never throws) so callers can print a
 * clean usage error and exit 1.
 */
function connect({ url, token, timeout } = {}, env = process.env) {
  const baseUrl = url || env.TG_URL;
  const bearer = token || env.TG_TOKEN;
  if (!baseUrl) return { error: 'no gateway URL — set TG_URL (or pass --url), e.g. TG_URL=http://127.0.0.1:8800' };
  if (!bearer) return { error: 'no token — set TG_TOKEN (or pass --token)' };
  try {
    return { client: new CliClient({ baseUrl, token: bearer, timeout }) };
  } catch (e) {
    return { error: e.message };
  }
}

module.exports = { CliClient, connect };
