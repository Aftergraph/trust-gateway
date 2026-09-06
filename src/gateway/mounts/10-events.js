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
// The `hello` frame stays chain-global (head hash + seq only — no
// entry content) for every client. Unknown/disabled tenant → 401
// at the query-auth layer (FS-A1 slice 2: tenant claim validated
// fail-closed in _auth before this mount runs — reveals nothing,
// same anti-enumeration guarantee as a 404).
//
// NOTE on plain-`http` testing: works fine — http.get keeps the response
// streaming and Node's `res.on('data', ...)` is how the test consumes it.

const { getHub } = require('../events');
const { resolveTenant } = require('../tenant-resolve');
const { enforceQuotas } = require('../tenant-scope');
const { send } = require('../server');

module.exports = {
  name: 'v2-events',
  method: 'GET',
  path: '/v2/events',
  auth: 'query',
  // §20: kun /v2/events kræver SSE-ticket-exchange (token lækker i URL).
  // Andre query-auth-mounts (fx 10-search) beholder ?token=.
  queryAuth: 'ticket',
  handle: async (gw, req, res, ctx) => {
    // §20: auth er sket via ?ticket= (30s single-use nonce, server.js
    // query-auth). Ticketet bærer et tenant-CLAIM (aldrig token-materiale);
    // rekonstruér authorization-headeren fra claimet, så resolveren kan læse
    // tnt_-prefixet (samme mønster som 10-search). Main-klienter har intet
    // claim → authorization efterlades tom → resolveren falder til main.
    const claim = ctx.ticketClaim || '';
    if (claim) req.headers.authorization = `Bearer ${claim}`;
    req.bot = ctx.bot;
    const { tenant } = resolveTenant(req, gw);
    if (!tenant) return send(res, 404, { error: 'not_found' });
    if (enforceQuotas(gw, tenant, res)) return; // FS-I3: fail-closed quotas

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
