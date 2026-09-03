'use strict';
// mount: /v2/telemetry — §20.4 post-launch telemetry (G12).
//
//   POST /v2/telemetry  {event, fields?}  auth: bearer (any authenticated bot
//     or the console token). Server-side allow-list: an unknown event name is
//     a hard 400 — the client cannot invent event types. Fields are projected
//     to scalars inside src/gateway/telemetry.js. Fire-and-forget from the
//     client; drops (rate-limit) are silent and still return ok.
//
//   GET /v2/telemetry?event=&since=   OPERATOR-ONLY (role 'operator' or '*').
//     Returns the ring buffer contents ({events:[{type,ts,fields}]}) with
//     optional type/since filters. Workers get 403 operator_required.
//
// NOT in the audit chain: telemetry is observability, not governance. No
// gw._audit() call here — the ring is a separate bounded file
// (data/telemetry.json) documented in TRANSPARENCY.md rows 82-93.

const { send } = require('../server');
const { readBody } = require('../server');
const { ALLOWED } = require('../telemetry');

function isOperator(bot) {
  if (!bot) return false;
  if (bot.role === 'operator') return true;
  const caps = Array.isArray(bot.capabilities) ? bot.capabilities : [];
  return caps.includes('*');
}

module.exports = {
  name: 'telemetry',
  method: '*',
  path: '/v2/telemetry',
  auth: 'bearer',
  handle: async (gw, req, res, ctx) => {
    if (req.method === 'POST') {
      let body;
      try {
        body = JSON.parse(await readBody(req) || '{}');
      } catch { return send(res, 400, { error: 'invalid_json' }); }
      const event = body && body.event;
      if (typeof event !== 'string' || !ALLOWED.has(event)) {
        return send(res, 400, { error: 'unknown_event' });
      }
      let fields = body.fields;
      if (fields === undefined || fields === null) fields = {};
      if (typeof fields !== 'object' || Array.isArray(fields)) {
        return send(res, 400, { error: 'invalid_fields' });
      }
      gw.telemetry.record(event, fields); // drops (rate-limit) are silent
      return send(res, 202, { ok: true });
    }
    if (req.method === 'GET') {
      if (!isOperator(ctx.bot)) return send(res, 403, { error: 'operator_required' });
      const event = ctx.url.searchParams.get('event');
      const since = Number(ctx.url.searchParams.get('since') || 0);
      const events = gw.telemetry.query({
        event: typeof event === 'string' && ALLOWED.has(event) ? event : null,
        since: Number.isFinite(since) && since > 0 ? since : 0,
      });
      return send(res, 200, { events });
    }
    return send(res, 405, { error: 'method_not_allowed' });
  },
};
