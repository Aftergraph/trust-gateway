'use strict';
// W3 mounts: custom-agent builder + per-bot profiles.
//
//   POST   /v2/agents            — create a custom agent
//   GET    /v2/agents            — list custom agents (agents hold no tokens)
//   GET    /v2/agents/:name      — fetch one
//   PUT    /v2/agents/:name      — update role/capabilities/persona
//   DELETE /v2/agents/:name      — remove (operator only)
//   GET    /v2/profiles/:who     — read a profile (own, or any with operator)
//   PUT    /v2/profiles/:who     — write a profile (own, or any with operator)
//
// Single mount file (loadMounts expects one export per file): method '*'
// plus a path RegExp; the handle dispatches on req.method + pathname.
//
// RBAC: creating/updating an agent whose role is 'operator' or whose
// capabilities include privileged caps (destructive/secret class, e.g.
// 'shell.run') requires an operator caller → 403 {error:'operator_required'}
// + audit entry type 'approval_forbidden'. Deleting any agent is privileged.
// Profiles: a bot may read/write only its own profile; operators any.
//
// Every decision goes through gw._audit(). Bot-facing projections never
// include tokens or secret values.

const { send, readBody } = require('../server');
const { getStore } = require('../agent-store');

// agents|profiles + name (also matches configured bot names for profiles).
const ROUTE_RE = /^\/v2\/(agents|profiles)\/?([a-z][a-z0-9-]{1,31})?$/;

// Hand-picked allow-list projection — a future sensitive field on the stored
// agent cannot accidentally leak through this endpoint.
function project(agent) {
  return {
    name: agent.name,
    role: agent.role,
    capabilities: Array.isArray(agent.capabilities) ? agent.capabilities.slice() : [],
    persona: agent.persona,
    createdAt: agent.createdAt,
  };
}

async function readJson(req, res) {
  let raw;
  try {
    raw = await readBody(req);
  } catch {
    send(res, 413, { error: 'body_too_large' });
    return null;
  }
  try {
    return JSON.parse(raw || '{}');
  } catch {
    send(res, 400, { error: 'invalid_json' });
    return null;
  }
}

function respondAgent(result, res, { createdStatus = 200 } = {}) {
  if (result.ok) return send(res, createdStatus, { ok: true, agent: project(result.agent) });
  const status = result.error === 'operator_required' ? 403
    : result.error === 'not_found' ? 404
    : result.error === 'exists' || result.error === 'name_reserved' ? 409
    : 400;
  return send(res, status, { error: result.error });
}

async function handle(gw, req, res, ctx) {
  const m = ROUTE_RE.exec(ctx.url.pathname);
  if (!m) return send(res, 404, { error: 'not_found' });
  const [, kind, name] = m;
  const method = req.method;
  const store = getStore(gw);
  const bot = ctx.bot;

  // ── /v2/agents ────────────────────────────────────────────────────
  if (kind === 'agents') {
    if (!name && method === 'POST') {
      const body = await readJson(req, res);
      if (body === null) return;
      if (typeof body !== 'object' || Array.isArray(body)) {
        return send(res, 400, { error: 'invalid_body' });
      }
      const result = store.create(body, bot);
      gw._audit({
        type: result.ok ? 'agent_created' : 'agent_rejected',
        agent: result.ok ? result.agent.name : String(body && body.name).slice(0, 64),
        by: bot.name,
        error: result.ok ? undefined : result.error,
      });
      if (result.error === 'operator_required') {
        // Distinct audit trail for privilege-escalation attempts.
        gw._audit({
          type: 'approval_forbidden',
          agent: String(body && body.name).slice(0, 64),
          by: bot.name,
          role: bot.role,
          action: 'agent_create_privileged',
        });
      }
      return respondAgent(result, res, { createdStatus: 201 });
    }

    if (!name && method === 'GET') {
      return send(res, 200, { agents: store.list().map(project) });
    }

    if (name && method === 'GET') {
      const agent = store.get(name);
      if (!agent) return send(res, 404, { error: 'not_found' });
      return send(res, 200, { agent: project(agent) });
    }

    if (name && method === 'PUT') {
      const body = await readJson(req, res);
      if (body === null) return;
      if (typeof body !== 'object' || Array.isArray(body)) {
        return send(res, 400, { error: 'invalid_body' });
      }
      const result = store.update(name, body, bot);
      gw._audit({
        type: result.ok ? 'agent_updated' : 'agent_rejected',
        agent: name,
        by: bot.name,
        error: result.ok ? undefined : result.error,
      });
      if (result.error === 'operator_required') {
        gw._audit({
          type: 'approval_forbidden',
          agent: name,
          by: bot.name,
          role: bot.role,
          action: 'agent_update_privileged',
        });
      }
      return respondAgent(result, res);
    }

    if (name && method === 'DELETE') {
      const result = store.remove(name, bot);
      gw._audit({
        type: result.ok ? 'agent_deleted' : 'agent_rejected',
        agent: name,
        by: bot.name,
        error: result.ok ? undefined : result.error,
      });
      if (result.error === 'operator_required') {
        gw._audit({
          type: 'approval_forbidden',
          agent: name,
          by: bot.name,
          role: bot.role,
          action: 'agent_delete',
        });
      }
      if (result.ok) return send(res, 200, { ok: true, deleted: name });
      const status = result.error === 'operator_required' ? 403
        : result.error === 'not_found' ? 404 : 400;
      return send(res, status, { error: result.error });
    }
  }

  // ── /v2/profiles/:who ─────────────────────────────────────────────
  if (kind === 'profiles' && name) {
    if (method === 'GET') {
      const result = store.getProfile(name, bot);
      if (!result.ok) {
        gw._audit({ type: 'approval_forbidden', profile: name, by: bot.name, action: 'profile_read' });
        return send(res, 403, { error: result.error });
      }
      return send(res, 200, { profile: result.profile });
    }
    if (method === 'PUT') {
      const body = await readJson(req, res);
      if (body === null) return;
      if (typeof body !== 'object' || Array.isArray(body)) {
        return send(res, 400, { error: 'invalid_body' });
      }
      const result = store.setProfile(name, body, bot);
      if (!result.ok) {
        const status = result.error === 'operator_required' ? 403 : 400;
        if (result.error === 'operator_required') {
          gw._audit({ type: 'approval_forbidden', profile: name, by: bot.name, action: 'profile_write' });
        }
        return send(res, status, { error: result.error });
      }
      gw._audit({ type: 'profile_updated', profile: name, by: bot.name, fields: result.fields });
      return send(res, 200, { ok: true, profile: result.profile });
    }
  }

  return send(res, 405, { error: 'method_not_allowed' });
}

module.exports = {
  name: 'v2-agents',
  method: '*',
  path: /^\/v2\/(agents|profiles)(\/[a-z][a-z0-9-]{1,31})?\/?$/,
  auth: 'bearer',
  handle,
};