'use strict';
// §20 test-hjælper: mønt et short-lived single-use SSE-ticket (POST
// /v2/events/ticket med Authorization-header) — ?token= er fail-closed
// fjernet fra /v2/events; streams kræver nu ?ticket=<nonce>.
const http = require('node:http');

function issueTicket(base, token) {
  return new Promise((resolve, reject) => {
    const u = new URL(base);
    const req = http.request({
      host: u.hostname,
      port: u.port,
      method: 'POST',
      path: '/v2/events/ticket',
      headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' },
    }, (res) => {
      let buf = '';
      res.on('data', (c) => { buf += c; });
      res.on('end', () => {
        try { resolve(JSON.parse(buf).ticket); } catch (e) { reject(new Error('ticket-issue fejlede: HTTP ' + res.statusCode + ' ' + buf.slice(0, 120))); }
      });
    });
    req.on('error', reject);
    req.end('{}');
  });
}

module.exports = { issueTicket };