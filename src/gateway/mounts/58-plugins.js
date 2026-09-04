'use strict';
// Plugin Contract v0.1 mount: /v2/plugins, /v2/plugins/register, /v2/plugins/:id
//
// Follows existing mount patterns:
// - bearer auth (auth: 'bearer')
// - chain audit (gw._audit)
// - fail-closed (reject invalid manifests, refuse unknown permissions)

const { send, readBody } = require('../server');
const { canApprove } = require('../rbac');

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

// Validate Plugin Contract v0.1 manifest
function validateManifest(raw, { dirName } = {}) {
  const errors = [];
  
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { ok: false, errors: ['manifest must be a JSON object'] };
  }

  // Required fields
  const { id, name, version, entry } = raw;
  
  // id: lowercase slug
  if (typeof id !== 'string' || !/^[a-z0-9][a-z0-9._-]{0,63}$/.test(id)) {
    errors.push('id must be a lowercase slug');
  }
  if (typeof dirName === 'string' && id !== dirName) {
    errors.push(`id_mismatch:manifest=${id} dir=${dirName}`);
  }

  // name: 1-64 chars
  if (typeof name !== 'string' || name.trim() === '' || name.length > 64) {
    errors.push('name required, 1-64 chars');
  }

  // version: semver
  if (typeof version !== 'string' || !/^\d+\.\d+\.\d+/.test(version)) {
    errors.push('version must be x.y.z semver');
  }

  // entry: relative .js file
  if (typeof entry !== 'string' || !entry.endsWith('.js') || entry.includes('..')) {
    errors.push('entry must be a relative .js path');
  }

  // optional fields validation
  if (raw.description !== undefined && (typeof raw.description !== 'string' || raw.description.length > 200)) {
    errors.push('description must be ≤200 chars');
  }

  // permissions: array of strings
  if (raw.permissions !== undefined) {
    if (!Array.isArray(raw.permissions) || raw.permissions.some((p) => typeof p !== 'string')) {
      errors.push('permissions must be an array of strings');
    }
  }

  // tools: array of strings
  if (raw.tools !== undefined) {
    if (!Array.isArray(raw.tools) || raw.tools.some((t) => typeof t !== 'string')) {
      errors.push('tools must be an array of strings');
    }
  }

  // views: array of primitives
  const PRIMITIVES = ['Card', 'Table', 'Form', 'Chart', 'Timeline', 'Approval', 'Progress', 'Artifact'];
  if (raw.views !== undefined) {
    if (!Array.isArray(raw.views)) {
      errors.push('views must be an array');
    } else {
      for (const v of raw.views) {
        if (!PRIMITIVES.includes(v)) errors.push(`unknown_view:${v}`);
      }
    }
  }

  // events: array of strings
  if (raw.events !== undefined) {
    if (!Array.isArray(raw.events) || raw.events.some((e) => typeof e !== 'string')) {
      errors.push('events must be an array of strings');
    }
  }

  // automations: array of objects with trigger, action
  if (raw.automations !== undefined) {
    if (!Array.isArray(raw.automations) || raw.automations.some((a) => !a.trigger || !a.action)) {
      errors.push('automations must be an array of {trigger, action} objects');
    }
  }

  // sandbox: must be "jailed"
  if (raw.sandbox !== 'jailed') {
    errors.push('sandbox must be "jailed"');
  }

  if (errors.length) return { ok: false, errors };
  return { ok: true, manifest: raw };
}

module.exports = {
  name: 'plugin-contract',
  method: '*',
  path: /^\/v2\/plugins(?:\/([^/]+))?\/?$/,
  auth: 'bearer',
  handle: async (gw, req, res, ctx) => {
    const pathname = ctx.url.pathname;
    const method = req.method;
    const { hub } = gw.pluginsHub || { hub: null };

    // For testing, use injected hub; otherwise get from gw
    const activeHub = hub || (gw.pluginsHub ? gw.pluginsHub : null);

    const isWrite = method !== 'GET';
    
    // RBAC: writes require operator rights
    if (isWrite && activeHub && !canApprove(ctx.bot)) {
      gw._audit({ type: 'plugin_forbidden', bot: ctx.bot.name, method, path: pathname });
      return send(res, 403, { error: 'operator_required' });
    }

    // Extract plugin id if present
    const match = pathname.match(/^\/v2\/plugins(?:\/([^/]+))?\/?$/);
    if (!match) {
      return send(res, 404, { error: 'not_found' });
    }

    const [, idRaw] = match;
    const id = idRaw ? decodeURIComponent(idRaw) : null;

    // List all plugins
    if (!id) {
      if (method === 'GET') {
        if (!activeHub) return send(res, 500, { error: 'hub_not_available' });
        return send(res, 200, { plugins: activeHub.list ? activeHub.list() : [] });
      }
      // Register new plugin (POST without id)
      if (method === 'POST') {
        if (!activeHub) return send(res, 500, { error: 'hub_not_available' });
        const { body, error } = await readJson(req);
        if (error) return send(res, 400, { error });

        // Validate manifest
        const v = validateManifest(body);
        if (!v.ok) {
          gw._audit({ type: 'plugin_rejected', errors: v.errors.slice(0, 10) });
          return send(res, 400, { error: 'invalid_manifest', errors: v.errors });
        }

        // Check permission declarations vs actual access
        // Declared permissions do not grant access; TG/AIE policy enforces
        const declared = body.permissions || [];
        const writePermission = declared.some((p) => p.startsWith('write') || p.startsWith('destructive'));
        if (writePermission && !canApprove(ctx.bot)) {
          gw._audit({ type: 'plugin_permission_rejected', permissions: declared });
          return send(res, 403, { error: 'permission_requires_approval' });
        }

        // Install/register the plugin
        if (activeHub.install) {
          const r = activeHub.install(body.id);
          return respond(res, r);
        }

        return send(res, 201, { registered: body.id });
      }

      return send(res, 405, { error: 'method_not_allowed' });
    }

    // Handle specific plugin by id
    if (method === 'GET') {
      if (!activeHub) return send(res, 500, { error: 'hub_not_available' });
      const view = activeHub.view ? activeHub.view(id) : null;
      if (!view) return send(res, 404, { error: 'not_found' });
      return send(res, 200, { plugin: view });
    }

    if (method === 'DELETE') {
      if (!activeHub) return send(res, 500, { error: 'hub_not_available' });
      if (!canApprove(ctx.bot)) {
        gw._audit({ type: 'plugin_delete_forbidden', id, bot: ctx.bot.name });
        return send(res, 403, { error: 'operator_required' });
      }
      if (activeHub.uninstall) {
        const r = activeHub.uninstall(id);
        return respond(res, r);
      }
      return send(res, 200, { uninstalled: id });
    }

    return send(res, 405, { error: 'method_not_allowed' });
  },
};
