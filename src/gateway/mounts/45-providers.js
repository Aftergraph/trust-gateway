'use strict';
// W6 mount — provider/model registry HTTP surface (single mount file;
// path is a RegExp so /v2/providers, /v2/providers/models,
// /v2/providers/plan and /v2/providers/probe all ride one registration).
//
//   GET  /v2/providers            → provider directory (no key material, ever)
//   GET  /v2/providers/models     → flat model catalog across providers
//   POST /v2/providers/plan       → {task, preferFree} free-tier-first routing plan
//   POST /v2/providers/probe      → OPTIONAL liveProbe (non-blocking, explicit)
//   GET  /v2/providers?probe=<n>  → optional non-blocking probe (off by default)
//
// SECURITY: the JSON.stringify of a raw record would be safe today (records
// hold no keys), but the projection is an explicit allow-list so a future
// field (e.g. an added apiKey ref) cannot accidentally leak. Tests assert
// no sk- pattern anywhere in any response.
//
// Decisions audited via gw._audit (plan + probe). Auth: bearer (the mount
// runner validates the token against gw.bots before this handler runs).

const { send } = require('../server');
// FS-A4: env-gated SQLite-backed registry. Env unset → byte-identical
// legacy providers-singleton path (same cached instance per gateway).
const { getProviders: getRegistry } = require('../providers-db');

const MAX_BODY = 64 * 1024;

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) { reject(new Error('body_too_large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

async function readJson(req) {
  const raw = await readBody(req);
  if (!raw) return {};
  return JSON.parse(raw); // throws on bad JSON
}

module.exports = {
  name: 'v2-providers',
  method: '*',
  path: /^\/v2\/providers(\/models|\/plan|\/probe)?$/,
  auth: 'bearer',
  handle: async (gw, req, res, ctx) => {
    const reg = getRegistry(gw);
    const sub = ctx.params.matches ? ctx.params.matches[1] : null;

    // ── GET /v2/providers[/models] ─────────────────────────────────
    if (req.method === 'GET') {
      if (sub === '/models') {
        return send(res, 200, { models: reg.models() });
      }
      let providers = reg.list();
      // Optional, non-blocking probe: only on explicit ?probe=<name>.
      let probe = null;
      const probeName = ctx.url.searchParams.get('probe');
      if (probeName) {
        probe = await reg.liveProbe(probeName); // never throws
        gw._audit({ type: 'provider_probe', provider: String(probeName), status: probe.status || probe.error });
      }
      return send(res, 200, { providers, probe });
    }

    // ── POST /v2/providers/plan ────────────────────────────────────
    if (req.method === 'POST' && sub === '/plan') {
      let body;
      try {
        body = await readJson(req);
      } catch (e) {
        return send(res, e.message === 'body_too_large' ? 413 : 400, { error: e.message === 'body_too_large' ? 'body_too_large' : 'invalid_json' });
      }
      if (body === null || typeof body !== 'object' || Array.isArray(body)) {
        return send(res, 400, { error: 'invalid_body' });
      }
      const task = typeof body.task === 'string' ? body.task.slice(0, 2000) : '';
      const preferFree = body.preferFree === undefined ? true : Boolean(body.preferFree);
      const maxLanes = Number.isFinite(body.maxLanes) ? Math.max(1, Math.min(20, Math.floor(body.maxLanes))) : 5;
      let plan;
      try {
        plan = reg.plan({ task, preferFree, maxLanes });
      } catch (e) {
        return send(res, 500, { error: 'plan_failed', detail: String(e && e.message) });
      }
      // Audit WITHOUT task text (free text could carry secrets) — tag only.
      gw._audit({
        type: 'provider_plan',
        taskTag: plan.taskTag,
        preferFree: plan.preferFree,
        primary: plan.primary,
        fallbackCount: plan.fallbacks.length,
      });
      return send(res, 200, plan);
    }

    // ── POST /v2/providers/probe {provider} ────────────────────────
    if (req.method === 'POST' && sub === '/probe') {
      let body;
      try {
        body = await readJson(req);
      } catch (e) {
        return send(res, e.message === 'body_too_large' ? 413 : 400, { error: e.message === 'body_too_large' ? 'body_too_large' : 'invalid_json' });
      }
      const name = typeof body.provider === 'string' ? body.provider : '';
      if (!reg.get(name)) return send(res, 404, { error: 'unknown_provider' });
      const out = await reg.liveProbe(name); // never throws, short timeout
      gw._audit({ type: 'provider_probe', provider: name, status: out.status || out.error });
      return send(res, 200, out);
    }

    return send(res, 405, { error: 'method_not_allowed' });
  },
};