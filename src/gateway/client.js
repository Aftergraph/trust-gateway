'use strict';
// Trust Gateway — zero-dependency Node client SDK.
// Wraps the HTTP API in src/gateway/server.js. CommonJS, node:http only.
//
// Contract recap (errors are returned, not thrown, for HTTP-level rejections):
//   POST  /v1/actions                 -> 200|202|403|502|401
//   GET   /v1/approvals               -> 200
//   POST  /v1/approvals/:id/approve   -> 200|403|404|409
//   POST  /v1/approvals/:id/deny      -> 200|403|404|409
//   GET   /v1/audit?since=N           -> 200
//   GET   /v1/audit/verify            -> 200
//   GET   /healthz                    -> 200 (no auth)

const http = require('node:http');
const { URL } = require('node:url');

class GatewayClient {
  /**
   * @param {object} opts
   * @param {string} opts.baseUrl  e.g. "http://100.71.253.52:8800"
   * @param {string} opts.token    Bearer token
   * @param {number} [opts.timeout=15000] per-request timeout in ms
   */
  constructor({ baseUrl, token, timeout = 15000 } = {}) {
    if (!baseUrl || typeof baseUrl !== 'string') throw new Error('baseUrl required');
    if (!token || typeof token !== 'string') throw new Error('token required');
    this.baseUrl = baseUrl.replace(/\/+$/, '');
    this.token = token;
    this.timeout = timeout;
  }

  /**
   * Propose an action. Returns the server's response body (already parsed).
   * Throws only on network / parse / timeout failures.
   * @param {string} tool
   * @param {object|null} [args]
   */
  action(tool, args = undefined) {
    const body = args === undefined ? { tool } : { tool, args };
    return this._request('POST', '/v1/actions', body);
  }

  /** List currently pending approval requests. */
  pending() {
    return this._request('GET', '/v1/approvals');
  }

  /** Approve a pending approval by id. */
  approve(id) {
    return this._request('POST', `/v1/approvals/${encodeURIComponent(id)}/approve`, {});
  }

  /** Deny a pending approval by id. */
  deny(id) {
    return this._request('POST', `/v1/approvals/${encodeURIComponent(id)}/deny`, {});
  }

  /** Verify the audit chain integrity. */
  verify() {
    return this._request('GET', '/v1/audit/verify');
  }

  /** Read audit entries since a given seq (default 0). */
  audit(since = 0) {
    const qs = since ? `?since=${encodeURIComponent(String(since))}` : '';
    return this._request('GET', `/v1/audit${qs}`);
  }

  /**
   * Central request helper. Returns the parsed JSON body. On a transport
   * failure (DNS, refused, parse error, timeout) we throw an Error. On any
   * HTTP response we resolve with the parsed body — even 4xx/5xx — so the
   * caller can branch on `decision` or `error` rather than try/catch around
   * every call.
   */
  _request(method, path, body) {
    return new Promise((resolve, reject) => {
      let url;
      try {
        url = new URL(this.baseUrl + path);
      } catch (e) {
        reject(new Error(`invalid baseUrl: ${this.baseUrl}`));
        return;
      }
      const payload = body === undefined ? null : JSON.stringify(body);
      const opts = {
        method,
        hostname: url.hostname,
        port: url.port || (url.protocol === 'https:' ? 443 : 80),
        path: url.pathname + url.search,
        headers: {
          authorization: `Bearer ${this.token}`,
          accept: 'application/json',
          ...(payload ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) } : {}),
        },
      };

      const req = http.request(opts, (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          if (!text) return resolve({});
          let parsed;
          try { parsed = JSON.parse(text); }
          catch (e) { return reject(new Error(`invalid JSON from ${method} ${path}: ${e.message}`)); }
          resolve(parsed);
        });
        res.on('error', reject);
      });

      req.setTimeout(this.timeout, () => {
        req.destroy(new Error(`request timed out after ${this.timeout}ms`));
      });
      req.on('error', reject);
      if (payload) req.write(payload);
      req.end();
    });
  }
}

module.exports = { GatewayClient };