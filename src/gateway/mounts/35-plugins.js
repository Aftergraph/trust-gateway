'use strict';
// v2 mount: /v2/plugins + /v2/skills + /v2/mcp — the W4 plugin/MCP/skills hub.
//
// One mount file, method '*', RegExp path — the mount runner has already
// bearer-authenticated the caller; this handler does its own RBAC for writes
// (operator or cap approval.decide/*, via canApprove) and routes the
// sub-surface:
//
//   GET    /v2/plugins                 list installed modules
//   POST   /v2/plugins                 {id} → install modules/<id> → data/modules/
//   GET    /v2/plugins/:id             one module view
//   POST   /v2/plugins/:id/enable      enable (audited)
//   POST   /v2/plugins/:id/disable     disable (audited)
//   DELETE /v2/plugins/:id             uninstall (removes running copy)
//   PUT    /v2/plugins/:id/secrets/:n  write-only secret; echo = length only
//   DELETE /v2/plugins/:id/secrets/:n  remove a secret
//   GET    /v2/skills                  parse skills from installed modules
//   GET    /v2/mcp                     MCP registry (env values never shown)
//   POST   /v2/mcp                     register {name, transport, ...}
//   DELETE /v2/mcp/:name               unregister
//
// All stateful decisions are audited by the hub via gw._audit.

const { send, readBody } = require('../server');
const { canApprove } = require('../rbac');
const { getPluginsHub } = require('../plugins');

const PLUGINS_RE = /^\/v2\/plugins(?:\/([^/]+)(?:\/([^/]+)(?:\/([^/]+))?)?)?\/?$/;
const SKILLS_RE = /^\/v2\/skills\/?$/;
const MCP_RE = /^\/v2\/mcp(?:\/([^/]+))?\/?$/;

async function readJson(req) {
  try {
    const raw = await readBody(req);
    return { body: raw ? JSON.parse(raw) : {} };
  } catch {
    return { error: 'invalid_json' };
  }
}

function respond(res, r) {
  const status = r.status || (r.ok ? 200 : 400);
  if (r.ok) {
    const { ok, status: _s, ...payload } = r;
    return send(res, status, payload);
  }
  const { ok, status: _s2, ...err } = r;
  return send(res, status, err);
}

module.exports = {
  name: 'v2-plugins',
  method: '*',
  path: /^\/v2\/(plugins|skills|mcp)(\/|$)/,
  auth: 'bearer',
  handle: async (gw, req, res, ctx) => {
    const hub = getPluginsHub(gw);
    const pathname = ctx.url.pathname;
    const method = req.method;
    const isWrite = method !== 'GET';

    // RBAC: any state change needs operator rights. Denied attempts are
    // audited without touching secrets or module contents.
    if (isWrite && !canApprove(ctx.bot)) {
      gw._audit({ type: 'plugins_forbidden', bot: ctx.bot.name, method, path: pathname });
      return send(res, 403, { error: 'operator_required' });
    }

    // ── /v2/skills ──
    if (SKILLS_RE.test(pathname)) {
      if (method !== 'GET') return send(res, 405, { error: 'method_not_allowed' });
      const { skills, rejected } = hub.discoverSkills();
      return send(res, 200, {
        skills: skills.map((s) => ({
          module: s.module, file: s.file, name: s.name,
          description: s.description, trigger: s.trigger,
        })),
        rejected,
      });
    }

    // ── /v2/mcp ──
    let m = MCP_RE.exec(pathname);
    if (m) {
      const [, name] = m;
      if (method === 'GET' && !name) return send(res, 200, { servers: hub.listMcp() });
      if (method === 'POST' && !name) {
        const { body, error } = await readJson(req);
        if (error) return send(res, 400, { error });
        return respond(res, hub.registerMcp(body));
      }
      if (method === 'DELETE' && name) {
        const r = hub.unregisterMcp(decodeURIComponent(name));
        return r.ok ? send(res, 200, { unregistered: decodeURIComponent(name) })
                    : send(res, r.status, { error: r.error });
      }
      return send(res, 405, { error: 'method_not_allowed' });
    }

    // ── /v2/plugins ──
    m = PLUGINS_RE.exec(pathname);
    if (!m) return send(res, 404, { error: 'not_found' });
    const [, idRaw, sub, sub2] = m;
    const id = idRaw ? decodeURIComponent(idRaw) : null;

    if (!id) {
      if (method === 'GET') return send(res, 200, { modules: hub.list() });
      if (method === 'POST') {
        const { body, error } = await readJson(req);
        if (error) return send(res, 400, { error });
        if (typeof body.id !== 'string') return send(res, 400, { error: 'id_required' });
        return respond(res, hub.install(body.id));
      }
      return send(res, 405, { error: 'method_not_allowed' });
    }

    if (!sub) {
      if (method === 'GET') {
        const view = hub.view(id);
        return view ? send(res, 200, { module: view }) : send(res, 404, { error: 'not_found' });
      }
      if (method === 'DELETE') {
        const r = hub.uninstall(id);
        return r.ok ? send(res, 200, { uninstalled: id }) : send(res, r.status, { error: r.error });
      }
      return send(res, 405, { error: 'method_not_allowed' });
    }

    if (sub === 'enable' || sub === 'disable') {
      if (method !== 'POST') return send(res, 405, { error: 'method_not_allowed' });
      const r = sub === 'enable' ? hub.enable(id) : hub.disable(id);
      return respond(res, r);
    }

    if (sub === 'secrets') {
      if (!sub2) return send(res, 404, { error: 'secret_name_required' });
      const name = decodeURIComponent(sub2);
      if (method === 'PUT') {
        const { body, error } = await readJson(req);
        if (error) return send(res, 400, { error });
        return respond(res, hub.setSecret(id, name, body.value));
      }
      if (method === 'DELETE') {
        const r = hub.removeSecret(id, name);
        return r.ok ? send(res, 200, r) : send(res, r.status, { error: r.error });
      }
      return send(res, 405, { error: 'method_not_allowed' });
    }

    return send(res, 404, { error: 'not_found' });
  },
};
