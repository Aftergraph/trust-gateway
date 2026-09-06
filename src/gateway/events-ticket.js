'use strict';
// §20 — SSE ticket exchange.
//
// EventSource cannot set Authorization headers, so the console used to
// hand the bearer token in the query string (?token=). Query strings leak
// into proxy access logs (Traefik/Nginx/edge) and browser history.
//
// Instead: POST /v2/events/ticket with a real Authorization header mints a
// SHORT-LIVED, SINGLE-USE nonce (30s TTL, 32-byte random). The SSE handshake
// then uses ?ticket=<nonce> — a value that is worthless after one use and
// expires in seconds, so a logged URL cannot be replayed into a stream.
//
// The ticket carries an identity CLAIM for tenant resolution — never token
// material: for tnt_-prefixed bot tokens we store only the tenant id with a
// literal stub rest ('tnt_<id>_ticket'), which is enough for the resolver's
// prefix regex and contains no secret.
const crypto = require('node:crypto');

const TICKET_TTL_MS = 30 * 1000;
const TNT_PREFIX_RE = /^(tnt_[a-z0-9-]{3,24}_).+$/;

// WeakMap singleton per gateway instance (same pattern as other stores).
const stores = new WeakMap();

function getSseTicketStore(gw) {
  let s = stores.get(gw);
  if (!s) {
    s = {
      tickets: new Map(),
      now: () => Date.now(),
      sweep() {
        const t = this.now();
        for (const [nonce, v] of this.tickets) {
          if (v.expires <= t) this.tickets.delete(nonce);
        }
      },
      // bot: authoritativt bot-objekt fra bearer-auth; claim: tnt_-prefix-stub
      // eller null (main). Returnerer nonce (hex).
      issue(bot, claim) {
        this.sweep();
        const nonce = crypto.randomBytes(32).toString('hex');
        this.tickets.set(nonce, { bot, claim, expires: this.now() + TICKET_TTL_MS });
        return nonce;
      },
      // Single-use: success → slettet; ugyldig/udløbet → null.
      redeem(nonce) {
        if (typeof nonce !== 'string' || !/^[0-9a-f]{64}$/.test(nonce)) return null;
        this.sweep();
        const v = this.tickets.get(nonce);
        if (!v) return null;
        this.tickets.delete(nonce);
        if (v.expires <= this.now()) return null; // udløbet i redeem-øjeblikket
        return { bot: v.bot, claim: v.claim };
      },
    };
    stores.set(gw, s);
  }
  return s;
}

// claimFor(bearerToken) → 'tnt_<id>_ticket' | null — aldrig token-materiale.
function claimFor(bearerToken) {
  if (typeof bearerToken !== 'string' || !bearerToken) return null;
  const token = bearerToken.replace(/^Bearer\s+/i, '');
  const m = TNT_PREFIX_RE.exec(token);
  if (!m) return null;
  return m[1] + 'ticket';
}

module.exports = { getSseTicketStore, claimFor, TICKET_TTL_MS };