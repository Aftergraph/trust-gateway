'use strict';
// §20 — POST /v2/events/ticket: SSE ticket exchange.
// Bearer-authenticated mint of a 30s single-use nonce for the
// EventSource handshake (EventSource cannot send Authorization headers;
// ?ticket= keeps the REAL token out of URLs, logs and history).
const { getSseTicketStore, claimFor, TICKET_TTL_MS } = require('../events-ticket');

module.exports = {
  name: 'v2-events-ticket',
  method: 'POST',
  path: '/v2/events/ticket',
  auth: 'bearer',
  handle: async (gw, req, res, ctx) => {
    const claim = claimFor(req.headers.authorization || '');
    const nonce = getSseTicketStore(gw).issue(ctx.bot, claim);
    gw._audit({ type: 'sse_ticket_issued', bot: ctx.bot ? ctx.bot.name : null, path: '/v2/events/ticket', data: { ttl: Math.round(TICKET_TTL_MS / 1000) } });
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({
      ticket: nonce,
      ttl: Math.round(TICKET_TTL_MS / 1000),
      expiresAt: Date.now() + TICKET_TTL_MS,
    }));
  },
};