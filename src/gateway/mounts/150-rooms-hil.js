'use strict';
// C3 mount: GET /v2/rooms/:id/hil — human-in-the-loop kort til rooms-tråden.
//
// Samler for rummet (ét kald til UI'et):
//   type 'approval'  — pending approvals med sessionRef === room_<roomId>
//                      (eller pending for room-bots uden sessionRef)
//   type 'needyou'   — NOW-projektionen (limit 10)
//   type 'takeover'  — aktive takeover-leases for room-bots (kun når filen findes)
//
// Card: { type, id, summary, actionable } — actionable=true betyder UI kan
// approve/deny/resolve direkte (via eksisterende /v1 + /v2 endpoints).
// Fail-closed: 404 ukendt room, 403 non-member. Ingen syntetiske items.
// Summary er metadata-only (tool + bot, aldrig args) — secret-hygiene.

const { send } = require('../server');
const { getRoomStore } = require('../groups');

const PATH_RE = /^\/v2\/rooms\/([^/]+)\/hil$/;

module.exports = {
  name: 'rooms-hil',
  method: 'GET',
  path: PATH_RE,
  auth: 'bearer',
  handle: async (gw, req, res, ctx) => {
    const m = (req.url || '').match(PATH_RE);
    const roomId = m ? decodeURIComponent(m[1]) : null;
    if (!roomId) return send(res, 400, { error: 'bad_path' });

    const bot = ctx.bot && ctx.bot.name;
    const room = getRoomStore(gw).get(roomId);
    if (!room) return send(res, 404, { error: 'not_found' });
    const isMember = bot && (room.members.bots.includes(bot) || room.members.humans.includes(bot));
    const isOperator = ctx.bot && (ctx.bot.role === 'operator' || ctx.bot.role === 'owner'
      || (Array.isArray(ctx.bot.capabilities) && ctx.bot.capabilities.includes('*')));
    if (!isMember && !isOperator) return send(res, 403, { error: 'not_member' });

    const sessionRef = `room_${roomId}`;
    const roomBots = new Set(room.members.bots);
    const cards = [];

    // 1) pending approvals koblet til rummet
    try {
      const pending = gw.approvals.listPending() || [];
      for (const a of pending) {
        if (a.sessionRef === sessionRef || (roomBots.has(a.bot) && !a.sessionRef)) {
          cards.push({
            type: 'approval',
            id: a.id,
            summary: `${a.bot}: ${a.tool}`,
            actionable: true,
          });
        }
      }
    } catch { /* approvals utilgængelige → udelades */ }

    // 2) need-you NOW (limit 10)
    try {
      const { NeedsYouStore } = require('../needsyou');
      const path = require('node:path');
      const store = new NeedsYouStore({ file: process.env.TG_NEEDYOU_FILE || 'data/needyou.json' });
      let items = [];
      if (typeof store.listNow === 'function') items = store.listNow();
      else if (typeof store.list === 'function') items = store.list();
      for (const n of items.slice(0, 10)) {
        cards.push({
          type: 'needyou',
          id: n.id,
          summary: `need-you: ${n.reason || n.title || n.id}`,
          actionable: true,
        });
      }
    } catch { /* need-you ej tilgængelig → udelades */ }

    // 3) takeovers — read-only på 33-takeover's fil (store ejes af den mount)
    try {
      const fs = require('node:fs');
      const tf = process.env.TG_TAKEOVER_FILE || 'data/takeovers.json';
      if (fs.existsSync(tf)) {
        const list = JSON.parse(fs.readFileSync(tf, 'utf8'));
        for (const t of (Array.isArray(list) ? list : list.takeovers || [])) {
          if (t && roomBots.has(t.principal_id) && (t.state === 'active' || t.active === true)) {
            cards.push({
              type: 'takeover',
              id: t.id || t.principal_id,
              summary: `takeover: ${t.principal_id} (${t.reason || ''})`,
              actionable: true,
            });
          }
        }
      }
    } catch { /* takeovers ej tilgængelige → udelades */ }

    gw._audit({ type: 'rooms_hil', roomId, cards: cards.length });
    send(res, 200, { ok: true, roomId, sessionRef, cards });
  },
};
