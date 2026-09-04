'use strict';
// mount: v2/need-you — NeedsYouItem API and NOW projection endpoint.
// Auth: bearer token (like 20-chat.js).

const { NeedsYouStore } = require('../needsyou');

const store = new NeedsYouStore({
  file: process.env.TG_NEEDYOU_FILE || 'data/needyou.json',
});

module.exports = {
  name: 'v2-needyou',
  method: '*',
  path: /^\/v2\/need-you(?:\/.*)?$/,
  auth: 'bearer',
  handle: async (gw, req, res, ctx) => {
    const pathname = ctx.url.pathname;
    const seg = pathname.split('/').filter(Boolean);
    const method = req.method;

    try {
      // GET /v2/need-you/now — NOW projection: open items sorted by urgency
      if (seg.length === 3 && seg[2] === 'now' && method === 'GET') {
        const items = store.listOpen();
        return send(res, 200, { items });
      }

      // GET /v2/need-you — list items for current tenant
      if (seg.length === 2 && method === 'GET') {
        if (!ctx.tenant || !ctx.tenant.id) {
          return send(res, 400, { error: 'tenant_required' });
        }
        const items = store.listByTenant(ctx.tenant.id);
        return send(res, 200, { items });
      }

      // POST /v2/need-you — create a new item
      if (seg.length === 2 && method === 'POST') {
        if (!ctx.tenant || !ctx.tenant.id) {
          return send(res, 400, { error: 'tenant_required' });
        }
        let raw = '';
        req.on('data', (c) => {
          raw += c;
          if (raw.length > 1024 * 1024) req.destroy();
        });
        await new Promise((r) => req.on('end', r));

        let doc;
        try {
          doc = JSON.parse(raw || '{}');
        } catch {
          return send(res, 400, { error: 'invalid_json' });
        }

        const validTypes = ['clarification', 'credential', 'budget', 'approval'];
        if (!doc.type || !validTypes.includes(doc.type)) {
          return send(res, 400, { error: 'invalid_type', valid: validTypes });
        }
        if (!doc.subject || typeof doc.subject !== 'string') {
          return send(res, 400, { error: 'subject_required' });
        }

        const item = store.create({
          tenantId: ctx.tenant.id,
          type: doc.type,
          subject: doc.subject,
          details: doc.details || null,
        });

        gw._audit({ type: 'needyou_created', id: item.id, tenantId: item.tenantId, type: item.type, subject: item.subject });
        return send(res, 201, { item });
      }

      // GET /v2/need-you/:id — get a single item
      if (seg.length === 3 && method === 'GET') {
        const item = store.get(seg[2]);
        if (!item) return send(res, 404, { error: 'not_found' });
        return send(res, 200, { item });
      }

      // POST /v2/need-you/:id/resolve — resolve an item
      if (seg.length === 4 && seg[3] === 'resolve' && method === 'POST') {
        const id = seg[2];
        if (!ctx.operator || !ctx.operator.name) {
          return send(res, 403, { error: 'operator_required' });
        }
        const result = store.resolve(id, ctx.operator.name);
        if (!result.ok) {
          return send(res, 400, { error: result.error });
        }
        gw._audit({ type: 'needyou_resolved', id: result.item.id, resolvedBy: result.item.resolvedBy });
        return send(res, 200, { item: result.item });
      }

      return send(res, 404, { error: 'not_found' });
    } catch (e) {
      return send(res, 500, { error: 'internal_error' });
    }
  },
};

function send(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(body);
}
