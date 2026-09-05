'use strict';
// P2 mount: /v2/knowledge — knowledge library CRUD + search + citations.
//
//   POST   /v2/knowledge                  create {title, kind, content, tags?, visibility?}
//   GET    /v2/knowledge/search?q=        token-index search (tenant-visible only for workers)
//   GET    /v2/knowledge/:id              one source
//   DELETE /v2/knowledge/:id              remove (operator-only)
//   POST   /v2/knowledge/:id/cite         {ref_type, ref_id} — record a citation
//
// Permissions: worker may create tenant-visible sources and search; operator may
// create operator-visible sources and delete. Reading operator-visible sources
// requires operator.

const { send, readBody } = require('../server');
async function readJson(req) {
  const raw = await readBody(req);
  try { return { body: raw ? JSON.parse(raw) : {} }; }
  catch { return { error: 'invalid_json' }; }
}
const { canApprove } = require('../rbac');
const { KnowledgeStore } = require('../knowledge.js');
const path = require('node:path');

const RE = /^\/v2\/knowledge(?:\/([^/]+)(?:\/cite)?)?\/?$/;

module.exports = {
  name: 'v2-knowledge',
  method: '*',
  path: /^\/v2\/knowledge(\/|$)/,
  auth: 'bearer',
  handle: async (gw, req, res, ctx) => {
    if (!gw._knowledgeStore) {
      gw._knowledgeStore = new KnowledgeStore({
        file: process.env.TG_KNOWLEDGE_FILE || path.join(process.cwd(), 'data', 'knowledge.json'),
      });
    }
    const store = gw._knowledgeStore;
    const m = RE.exec(ctx.url.pathname);
    if (!m) return send(res, 404, { error: 'not_found' });
    const [, id, sub] = m;

    if (req.method === 'GET' && !id && !sub) {
      // list is handled by search with empty query? No — provide listing.
      return send(res, 200, { sources: [...store.sources.values()].map((s) => ({
        id: s.id, title: s.title, kind: s.kind, visibility: s.visibility, tags: s.tags,
      })) });
    }
    if (req.method === 'GET' && id === 'search') {
      const q = new URL(ctx.url.href).searchParams.get('q') || '';
      const hits = store.search(q).filter((s) => s.visibility === 'tenant' || canApprove(ctx.bot));
      gw._audit({ type: 'knowledge_searched', query: q, hits: hits.length });
      return send(res, 200, { hits });
    }
    if (req.method === 'GET' && id) {
      const src = store.get(id);
      if (!src) return send(res, 404, { error: 'not_found' });
      if (src.visibility === 'operator' && !canApprove(ctx.bot)) {
        return send(res, 403, { error: 'forbidden' });
      }
      return send(res, 200, src);
    }
    if (req.method === 'POST' && !id) {
      const { body, error } = await readJson(req);
      if (error) return send(res, 400, { error });
      try {
        const src = store.create({ ...body, created_by: ctx.bot.name });
        gw._audit({ type: 'knowledge_created', source_id: src.id, title: src.title });
        return send(res, 201, { ok: true, source: src });
      } catch (e) {
        return send(res, 400, { error: e.message });
      }
    }
    if (req.method === 'POST' && id && sub === 'cite') {
      const { body, error } = await readJson(req);
      if (error) return send(res, 400, { error });
      try {
        const src = store.cite(id, body);
        gw._audit({ type: 'knowledge_cited', source_id: id, ref_type: body.ref_type, ref_id: body.ref_id });
        return send(res, 200, { ok: true, source: src });
      } catch (e) {
        const status = /unknown id/.test(e.message) ? 404 : 400;
        return send(res, status, { error: e.message });
      }
    }
    if (req.method === 'DELETE' && id) {
      if (!canApprove(ctx.bot)) {
        gw._audit({ type: 'knowledge_delete_forbidden', source_id: id, bot: ctx.bot.name });
        return send(res, 403, { error: 'operator_required' });
      }
      const removed = store.remove(id);
      if (!removed) return send(res, 404, { error: 'not_found' });
      gw._audit({ type: 'knowledge_removed', source_id: id });
      return send(res, 200, { ok: true });
    }
    return send(res, 405, { error: 'method_not_allowed' });
  },
};