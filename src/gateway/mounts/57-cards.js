'use strict';
// mount: v2/cards — card validation API and list of recently validated/proposed cards.
// Auth: bearer token (like 20-chat.js).
// In-memory ring for recent cards.

const MAX_RECENT = 50;
const recentCards = [];

module.exports = {
  name: 'v2-cards',
  method: '*',
  path: /^\/v2\/cards(?:\/.*)?$/,
  auth: 'bearer',
  handle: async (gw, req, res, ctx) => {
    const pathname = ctx.url.pathname;
    const seg = pathname.split('/').filter(Boolean);
    const method = req.method;

    try {
      // POST /v2/cards/validate — validate a card payload against the schema
      if (seg.length === 3 && seg[2] === 'validate' && method === 'POST') {
        let raw = '';
        req.on('data', (c) => {
          raw += c;
          if (raw.length > 1024 * 1024) req.destroy(); // 1MB limit
        });
        await new Promise((r) => req.on('end', r));

        let doc;
        try {
          doc = JSON.parse(raw || '{}');
        } catch {
          return send(res, 400, { error: 'invalid_json' });
        }

        const cardModule = require('../../../app/cards');
        const validateCardDocument = cardModule.validateCardDocument || function() { return { ok: false, errors: ['validation not found'] }; };

        const result = validateCardDocument(doc);

        if (!result.ok) {
          return send(res, 400, { ok: false, errors: result.errors });
        }

        // Add to recent list
        const entry = {
          ts: Date.now(),
          doc: doc,
          bot: req.bot ? req.bot.name : 'unknown'
        };
        recentCards.push(entry);
        if (recentCards.length > MAX_RECENT) {
          recentCards.shift();
        }

        return send(res, 200, { ok: true });
      }

      // GET /v2/cards — list recently validated/proposed cards
      if (seg.length === 2 && method === 'GET') {
        return send(res, 200, { cards: recentCards });
      }

      return send(res, 404, { error: 'not_found' });
    } catch (e) {
      return send(res, 500, { error: 'internal_error' });
    }
  }
};

function send(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(body);
}
