'use strict';
// v2 mount: GET /v2/events — Server-Sent Events feed of audit entries.
//
// Auth mode is 'query' because browser EventSource cannot set custom
// request headers. The mount runner in server.js has already verified
// ?token=<bearer> against the gateway's bot table before this handler
// runs, so ctx.bot is the authenticated bot.
//
// FS-E1d: tenant-scoped streams. The token's tenant prefix claim
// ('tnt_<id>_…') is resolved AFTER query-auth (auth itself untouched).
// The main tenant keeps the unfiltered firehose byte-identically; any
// other tenant receives ONLY `event: audit` frames whose entry is tagged
// with ITS OWN tenant id (payload.tenant === id) — never another
// tenant's entries, never untagged main entries, and never the untagged
// projection broadcasts (artifact/computer/room) that carry no tenant
// tag. The `hello` frame stays chain-global (head hash + seq only — no
// entry content) for every client. Unknown/disabled tenant → 404
// (anti-enumeration, never 403).
//
// NOTE on plain-`http` testing: works fine — http.get keeps the response
// streaming and Node's `res.on('data', ...)` is how the test consumes it.

const { getHub } = require('../events');
const { resolveTenant } = require('../tenant-resolve');
const { send } = require('../server');

module.exports = {
  name: 'v2-events',
  method: 'GET',
  path: '/v2/events',
  auth: 'query',
  handle: async (gw, req, res, ctx) => {
    // Reconstruct the bearer header the query-auth runner already validated
    // so the resolver can read the tenant prefix claim off the same token
    // (same pattern as 10-search). req.bot exposes the authenticated bot for
    // the resolver's operator check (X-Tenant is honoured for operators only).
    const tk = ctx.url.searchParams.get('token') || '';
    req.headers.authorization = `Bearer ${tk}`;
    req.bot = ctx.bot;
    const { tenant } = resolveTenant(req, gw);
    if (!tenant) return send(res, 404, { error: 'not_found' });

    if (tenant.id === 'main') {
      getHub(gw).addClient(res); // unfiltered — byte-identical
      return;
    }
    // Tenant-scoped stream: only audit frames tagged with the caller's own
    // tenant id. The hello frame stays chain-global (head hash + seq only —
    // no entry content) for every client.
    getHub(gw).addClient(res, (entry) => !!(entry && entry.payload && entry.payload.tenant === tenant.id));
    // addClient attaches 'close' / 'error' listeners; nothing to await.
  },
};
