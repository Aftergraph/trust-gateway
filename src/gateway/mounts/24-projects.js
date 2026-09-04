'use strict';
// P1 mount: /v2/projects — Project primitive v1 (overview surface + Needs You signals).
//
//   POST   /v2/projects                     create {title, description?, goal?}
//   GET    /v2/projects                     list (?status=)
//   GET    /v2/projects/:id                 full project (overview data)
//   POST   /v2/projects/:id/attach          {kind: conversations|missions, ref}
//   POST   /v2/projects/:id/activity        {type, description}
//   POST   /v2/projects/:id/needs-you       {approval_request|human_input|budget_action}
//   POST   /v2/projects/:id/needs-you/resolve {index}
//   POST   /v2/projects/:id/blockers        {type, description, blocking_work?}
//   POST   /v2/projects/:id/blockers/resolve {index}
//   POST   /v2/projects/:id/status          {status}
//
// Health is DERIVED (blockers => degraded), never manually set via HTTP.

const { send, readBody } = require('../server');
const { ProjectStore } = require('../projects');

const RE = /^\/v2\/projects(?:\/([^/]+)(?:\/([^/]+)(?:\/([^/]+))?)?)?\/?$/;

async function readJson(req) {
  try {
    const raw = await readBody(req);
    return { body: raw ? JSON.parse(raw) : {} };
  } catch {
    return { error: 'invalid_json' };
  }
}

module.exports = {
  name: 'v2-projects',
  method: '*',
  path: /^\/v2\/projects(\/|$)/,
  auth: 'bearer',
  handle: async (gw, req, res, ctx) => {
    if (!gw._projectStore) gw._projectStore = new ProjectStore();
    const store = gw._projectStore;
    const m = RE.exec(ctx.url.pathname);
    if (!m) return send(res, 404, { error: 'not_found' });
    const [, id, action] = m;

    if (req.method === 'GET' && !id) {
      return send(res, 200, { projects: store.list() });
    }
    if (req.method === 'GET' && id) {
      const p = store.get(id);
      if (!p) return send(res, 404, { error: 'not_found' });
      return send(res, 200, p);
    }
    if (req.method === 'POST' && !id) {
      const { body, error } = await readJson(req);
      if (error) return send(res, 400, { error });
      try {
        const proj = store.create(body);
        gw._audit({ type: 'project_created', project_id: proj.id, title: proj.title });
        return send(res, 201, { ok: true, project: proj });
      } catch (e) {
        return send(res, 400, { error: e.message });
      }
    }
    if (req.method === 'POST' && id) {
      const { body, error } = await readJson(req);
      if (error) return send(res, 400, { error });
      try {
        let p;
        if (action === 'attach') p = store.attach(id, body.kind, body.ref);
        else if (action === 'activity') p = store.logActivity(id, body.type, body.description);
        else if (action === 'needs-you') p = store.addNeedsYou(id, body);
        else if (action === 'needs-you/resolve') { ({ p } = store.resolveNeedsYou(id, body.index)); }
        else if (action === 'blockers') p = store.addBlocker(id, body);
        else if (action === 'blockers/resolve') p = store.resolveBlocker(id, body.index);
        else if (action === 'status') p = store.setStatus(id, body.status);
        else return send(res, 404, { error: 'unknown_action' });
        return send(res, 200, { ok: true, project: p });
      } catch (e) {
        const msg = String(e.message);
        const status = /unknown id/.test(msg) ? 404 : 400;
        return send(res, status, { error: msg });
      }
    }
    return send(res, 405, { error: 'method_not_allowed' });
  },
};