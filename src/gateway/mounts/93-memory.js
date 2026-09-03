'use strict';
// v2 wave F3 mount: per-agent memory (inspectable fact objects).
//
// Routes (all bearer):
//   GET  /v2/memory?bot=<name>        → list facts (no sourceChainSeq in body)
//   GET  /v2/memory/:id               → get one fact
//   POST /v2/memory                   → create a fact {bot, text, source?, tags?, pin?, decayAt?}
//   PATCH /v2/memory/:id              → edit {text?, tags?, pin?, decayAt?}
//   DELETE /v2/memory/:id             → remove (audits memory_removed)
//
// RBAC: worker may only touch their own bot's memory; operator may
// access any bot's memory. Decay: facts with decayAt in the past are
// filtered from default GET unless ?include=expired. Pinned facts
// ignore decay. Expired facts are NEVER auto-deleted (spec rule).

const { send, readBody } = require('../server');
const { getMemoryStore } = require('../memory');

function botAllowed(gw, bot, targetBot) {
  if (bot.name === targetBot) return true;
  return bot.role === 'operator';
}

module.exports = {
  name: 'v2-memory',
  method: '*',
  path: /^\/v2\/memory(?:\/.*)?$/,
  auth: 'bearer',
  handle: async (gw, req, res, ctx) => {
    const bot = ctx.bot;
    const pathname = ctx.url.pathname;
    const url = ctx.url;
    const store = getMemoryStore(gw);

    try {
      // ── GET /v2/memory?bot=<name> — list facts ──
      if (req.method === 'GET' && !hasIdSegment(pathname)) {
        const targetBot = url.searchParams.get('bot');
        if (!targetBot) return send(res, 400, { error: 'bot query param required' });
        if (!botAllowed(gw, bot, targetBot)) {
          return send(res, 403, { error: 'forbidden' });
        }
        const includeExpired = url.searchParams.get('include') === 'expired';
        const facts = store.list(targetBot, { includeExpired });
        // NEVER include sourceChainSeq in default list (prevents seq-jumping UI bugs)
        const projected = facts.map((f) => ({
          id: f.id,
          text: f.text,
          source: f.source,
          tags: f.tags,
          pin: f.pin,
          createdAt: f.createdAt,
          lastUsedAt: f.lastUsedAt,
          decayAt: f.decayAt,
        }));
        return send(res, 200, { facts: projected, bot: targetBot });
      }

      // ── GET /v2/memory/:id — get one fact ──
      if (req.method === 'GET' && hasIdSegment(pathname)) {
        const id = decodeURIComponent(seg(pathname)[2]);
        const fact = store.get(bot.name, id);
        if (!fact) return send(res, 404, { error: 'not_found' });
        if (!botAllowed(gw, bot, fact.bot)) {
          return send(res, 403, { error: 'forbidden' });
        }
        return send(res, 200, fact);
      }

      // ── POST /v2/memory — create ──
      if (req.method === 'POST' && !hasIdSegment(pathname)) {
        let body;
        try { body = JSON.parse((await readBody(req)) || '{}'); }
        catch { return send(res, 400, { error: 'invalid_json' }); }
        const { bot: botName, text, source, tags, pin, decayAt } = body || {};
        if (!botName || typeof botName !== 'string') return send(res, 400, { error: 'bot required' });
        if (!botAllowed(gw, bot, botName)) {
          return send(res, 403, { error: 'forbidden' });
        }
        // Audit first to capture chain seq for sourceChainSeq on the fact
        const auditEntry = gw._audit({ type: 'memory_added', bot: botName, source: source || 'user' });
        const fact = store.create({ bot: botName, text, source: source || 'user', tags, pin, decayAt, sourceChainSeq: auditEntry.seq });
        return send(res, 201, fact);
      }

      // ── PATCH /v2/memory/:id — edit ──
      if (req.method === 'PATCH' && hasIdSegment(pathname)) {
        const id = decodeURIComponent(seg(pathname)[2]);
        const fact = store.get(bot.name, id);
        if (!fact) return send(res, 404, { error: 'not_found' });
        if (!botAllowed(gw, bot, fact.bot)) {
          return send(res, 403, { error: 'forbidden' });
        }
        let body;
        try { body = JSON.parse((await readBody(req)) || '{}'); }
        catch { return send(res, 400, { error: 'invalid_json' }); }
        const { text, tags, pin, decayAt } = body || {};
        const updated = store.edit(id, { text, tags, pin, decayAt });
        gw._audit({ type: 'memory_edited', id, bot: updated.bot });
        return send(res, 200, updated);
      }

      // ── DELETE /v2/memory/:id — remove ──
      if (req.method === 'DELETE' && hasIdSegment(pathname)) {
        const id = decodeURIComponent(seg(pathname)[2]);
        let factBot = null;
        for (const bn of Object.keys(store.bots)) {
          if (store.bots[bn].facts.some((f) => f.id === id)) { factBot = bn; break; }
        }
        if (!factBot) return send(res, 404, { error: 'not_found' });
        if (!botAllowed(gw, bot, factBot)) {
          return send(res, 403, { error: 'forbidden' });
        }
        const removed = store.remove(id);
        gw._audit({ type: 'memory_removed', id: removed.id, bot: removed.bot, sourceChainSeq: removed.sourceChainSeq || null });
        return send(res, 200, { id: removed.id, bot: removed.bot });
      }

      return send(res, 404, { error: 'not_found' });
    } catch (e) {
      if (String(e && e.message) === 'body_too_large') return send(res, 413, { error: 'body_too_large' });
      return send(res, 500, { error: 'internal_error' });
    }
  },
};

function hasIdSegment(p) { return p.split('/').filter(Boolean).length === 3; }
function seg(p) { return p.split('/').filter(Boolean); }
