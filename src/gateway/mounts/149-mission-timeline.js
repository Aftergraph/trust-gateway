'use strict';
// C1 mount: GET /v2/rooms/:id/missiontimeline — live mission-thread.
//
// Samler mission-relevante hændelser for rummet i én kronologisk timeline:
//   source 'room'     — room-beskeder (message/proposal/handoff/assistant)
//   source 'workflow' — workflow-runs med sessionRef === room_<roomId>
//   source 'works'    — WORKS-executions (kun når WORKS_API_URL er sat; ellers
//                       udelades stille — ingen syntetiske entries)
//
// Entry: { ts, source, kind, summary, ref }
//   summary er KORT (≤120 tegn, tronkleret) og aldrig hemmelig content:
//   room-entries viser kind + bodyLength, ikke tekst (secret-hygiene som
//   proposal-mounts). Fail-closed: 404 ukendt room, 403 non-member.
//
// Timeline returneres nyeste-først. Limit: seneste 200 entries.

const { send } = require('../server');
const { getRoomStore } = require('../groups');

const PATH_RE = /^\/v2\/rooms\/([^/]+)\/missiontimeline$/;
const MAX_ENTRIES = 200;
const SUMMARY_MAX = 120;

function clip(s) {
  s = String(s || '');
  return s.length > SUMMARY_MAX ? s.slice(0, SUMMARY_MAX - 1) + '…' : s;
}

module.exports = {
  name: 'mission-timeline',
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

    const entries = [];

    // 1) room-hændelser (metadata-only summaries)
    for (const msg of room.messages || []) {
      const base = { ts: msg.ts, source: 'room', ref: { messageId: msg.id } };
      if (msg.kind === 'proposal') {
        entries.push({ ...base, kind: 'proposal', summary: clip(`proposal: ${msg.body && msg.body.tool || '?'}`) });
      } else if (msg.kind === 'handoff') {
        entries.push({ ...base, kind: 'handoff', summary: clip(`handoff → ${msg.target || '?'}`) });
      } else if (msg.kind === 'assistant') {
        entries.push({ ...base, kind: 'assistant',
          summary: clip(`assistant svar${msg.proposal ? ` (proposal: ${msg.proposal.tool})` : ''}${msg.fallback ? ' [fallback]' : ''}`) });
      } else if (msg.body && typeof msg.body === 'object' && msg.body.attachment) {
        entries.push({ ...base, kind: 'attachment', summary: clip(`attachment: ${msg.body.attachment.name || '?'}`) });
      } else {
        entries.push({ ...base, kind: 'message', summary: clip(`${msg.from}: (besked, ${String(msg.body || '').length} tegn)`) });
      }
    }

    // 2) workflow-runs koblet til rummet via sessionRef
    try {
      const { getWorkflowStore } = require('../workflows');
      const wfStore = getWorkflowStore(gw);
      const sessionRef = `room_${roomId}`;
      const runs = (typeof wfStore.list === 'function' ? wfStore.list() : [])
        .filter((w) => w && (w.sessionRef === sessionRef || w.trigger && w.trigger.sessionRef === sessionRef));
      for (const w of runs.slice(-100)) {
        entries.push({ ts: w.updatedAt || w.createdAt || null, source: 'workflow', kind: w.state || 'run',
          summary: clip(`workflow ${w.id || w.name || ''} ${w.state || ''}`), ref: { workflowId: w.id } });
      }
    } catch { /* workflows ej tilgængelige → udelades stille */ }

    // 3) WORKS-executions (kun når konfigureret)
    try {
      const worksClient = require('../works-client');
      const { url } = worksClientCfg();
      if (url) {
        const resp = await fetch(`${url.replace(/\/$/, '')}/v1/works?limit=50`, {
          headers: worksClientCfg().token ? { authorization: `Bearer ${worksClientCfg().token}` } : {},
          signal: AbortSignal.timeout(5000),
        });
        if (resp.ok) {
          const data = await resp.json();
          for (const w of (Array.isArray(data) ? data : data.works || [])) {
            if (w && w.correlation_id === `room_${roomId}`) {
              entries.push({ ts: w.updated_at || w.created_at || null, source: 'works', kind: w.state || 'work',
                summary: clip(`WORKS ${w.id} ${w.state || ''}`), ref: { workId: w.id } });
            }
          }
        }
      }
    } catch { /* works utilgængelig → udelades stille (fail-closed, ingen fake) */ }

    entries.sort((a, b) => (b.ts || 0) - (a.ts || 0));
    gw._audit({ type: 'mission_timeline', roomId, entries: entries.length });
    send(res, 200, {
      ok: true,
      roomId,
      sessionRef: `room_${roomId}`,
      entries: entries.slice(0, MAX_ENTRIES),
      count: entries.length,
    });
  },
};

function worksClientCfg() {
  return { url: process.env.WORKS_API_URL || '', token: process.env.WORKS_API_TOKEN || '' };
}
