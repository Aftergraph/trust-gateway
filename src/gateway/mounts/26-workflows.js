'use strict';
// P2 mount: /v2/workflows — workflow CRUD + run-via-WORKS.
//
//   POST   /v2/workflows                  create {name, steps, triggers?}
//   GET    /v2/workflows                  list (?status=)
//   GET    /v2/workflows/:id              one workflow
//   PUT    /v2/workflows/:id              update {steps?, triggers?, name?} (version bump)
//   POST   /v2/workflows/:id/activate     draft -> active
//   POST   /v2/workflows/:id/archive      -> archived
//   POST   /v2/workflows/:id/run          maps to a WORKS Work and submits via works-client
//                                          {queue?: boolean} — fail-closed if the control
//                                          plane is unconfigured (works ok:false passthrough)
//
// RBAC: create/update/run require operator (workflows trigger side effects via WORKS);
// GET list/get allowed for any authenticated bot.

const { send, readBody } = require('../server');
const { canApprove } = require('../rbac');
const { WorkflowStore } = require('../workflows.js');
const worksClient = require('../works-client.js');

const RE = /^\/v2\/workflows(?:\/([^/]+)(?:\/([^/]+))?)?\/?$/;

async function readJson(req) {
  try {
    const raw = await readBody(req);
    return { body: raw ? JSON.parse(raw) : {} };
  } catch {
    return { error: 'invalid_json' };
  }
}

module.exports = {
  name: 'v2-workflows',
  method: '*',
  path: /^\/v2\/workflows(\/|$)/,
  auth: 'bearer',
  handle: async (gw, req, res, ctx) => {
    if (!gw._workflowStore) gw._workflowStore = new WorkflowStore();
    const store = gw._workflowStore;
    const m = RE.exec(ctx.url.pathname);
    if (!m) return send(res, 404, { error: 'not_found' });
    const [, id, action] = m;

    if (req.method === 'GET' && !id) return send(res, 200, { workflows: store.list() });
    if (req.method === 'GET' && id) {
      const w = store.get(id);
      if (!w) return send(res, 404, { error: 'not_found' });
      return send(res, 200, w);
    }
    if (req.method === 'POST' && !id) {
      const { body, error } = await readJson(req);
      if (error) return send(res, 400, { error });
      try {
        const w = store.create({ ...body, created_by: ctx.bot.name });
        gw._audit({ type: 'workflow_created', workflow_id: w.id, name: w.name, version: w.version });
        return send(res, 201, { ok: true, workflow: w });
      } catch (e) {
        return send(res, 400, { error: e.message });
      }
    }
    if (req.method === 'PUT' && id) {
      const { body, error } = await readJson(req);
      if (error) return send(res, 400, { error });
      try {
        const w = store.update(id, body);
        gw._audit({ type: 'workflow_updated', workflow_id: id, version: w.version });
        return send(res, 200, { ok: true, workflow: w });
      } catch (e) {
        return send(res, 400, { error: e.message });
      }
    }
    if (req.method === 'POST' && id) {
      const { body, error } = await readJson(req);
      if (error) return send(res, 400, { error });
      try {
        if (action === 'activate') {
          const w = store.activate(id);
          gw._audit({ type: 'workflow_activated', workflow_id: id });
          return send(res, 200, { ok: true, workflow: w });
        }
        if (action === 'archive') {
          const w = store.archive(id);
          gw._audit({ type: 'workflow_archived', workflow_id: id });
          return send(res, 200, { ok: true, workflow: w });
        }
        if (action === 'run') {
          if (!canApprove(ctx.bot)) {
            gw._audit({ type: 'workflow_run_forbidden', workflow_id: id, bot: ctx.bot.name });
            return send(res, 403, { error: 'operator_required' });
          }
          const w = store._must(id);
          if (w.status !== 'active') return send(res, 409, { error: 'not_active', status: w.status });
          const workBody = store.toWorksWork(w);
          const out = await worksClient.createWork({
            objective: workBody.objective,
            mission_id: `workflow_${id}`,
            queue: body.queue !== false,
          });
          gw._audit({
            type: 'workflow_run_submitted',
            workflow_id: id,
            version: w.version,
            works_ok: out.ok,
            work_id: out.work_id || null,
          });
          if (!out.ok) return send(res, 502, { error: 'works_submission_failed', detail: out.reason });
          return send(res, 200, { ok: true, work_id: out.work_id, workflow: w });
        }
        return send(res, 404, { error: 'unknown_action' });
      } catch (e) {
        const msg = String(e.message);
        const status = /unknown id/.test(msg) ? 404 : 400;
        return send(res, status, { error: msg });
      }
    }
    return send(res, 405, { error: 'method_not_allowed' });
  },
};