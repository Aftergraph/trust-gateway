'use strict';
// C4 mount — adapter registry HTTP surface. ONE RegExp mount covers the whole
// /v2/adapters tree (single registration, wave C mount pattern):
//
//   GET    /v2/adapters              → secret-free list
//   POST   /v2/adapters              → register {kind, name, config}
//   GET    /v2/adapters/:id          → secret-free projection
//   PATCH  /v2/adapters/:id          → update {name?, config?, enabled?}
//   DELETE /v2/adapters/:id          → remove
//   POST   /v2/adapters/:id/test     → probe → {result: ok|fail|blocked}
//   POST   /v2/adapters/:id/secret   → {name, value} stored as hash only
//
// Every mutation and every probe is audited via gw._audit with hostnames
// only — never a URL with credentials, never a secret value.
// Auth: bearer (validated by the mount runner before this handler runs).

const { send } = require('../server');
const { getAdapters } = require('../adapters-singleton');

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

// never log a URL — secrets hide in query strings and credentials
function auditTarget(def) {
  if (!def) return null;
  const cfg = def.config || {};
  const raw = cfg.url || cfg.baseUrl || '';
  let host = null;
  try { host = new URL(String(raw)).host; } catch { host = null; }
  return host || null;
}

module.exports = {
  name: 'v2-adapters',
  method: '*',
  path: /^\/v2\/adapters(\/[\w-]+)?(\/test|\/secret)?$/,
  auth: 'bearer',
  handle: async (gw, req, res, ctx) => {
    const reg = getAdapters(gw);
    const m = ctx.params.matches || [];
    const id = m[1] ? m[1].slice(1) : null; // strip leading slash
    const action = m[2] ? m[2].slice(1) : null; // 'test' | 'secret' | null

    // ── GET ────────────────────────────────────────────────────────────────
    if (req.method === 'GET') {
      if (id) {
        const def = reg.get(id);
        if (!def) return send(res, 404, { error: 'not_found' });
        return send(res, 200, { adapter: reg.project(def) });
      }
      return send(res, 200, { adapters: reg.list().map((d) => reg.project(d)) });
    }

    if (req.method !== 'POST' && !(req.method === 'DELETE' && id) && !(req.method === 'PATCH' && id)) {
      return send(res, 405, { error: 'method_not_allowed' });
    }

    // ── POST /v2/adapters/:id/test ─────────────────────────────────────────
    if (action === 'test') {
      if (req.method !== 'POST') return send(res, 405, { error: 'method_not_allowed' });
      const out = await reg.test(id); // never throws
      const def = reg.get(id);
      // audit: id, kind, result only — never the URL (secrets in query strings)
      gw._audit({ type: 'adapter_tested', id, kind: out.kind, result: out.result });
      void auditTarget(def);
      return send(res, 200, out);
    }

    // ── POST /v2/adapters/:id/secret {name, value} ─────────────────────────
    if (action === 'secret') {
      if (req.method !== 'POST') return send(res, 405, { error: 'method_not_allowed' });
      let body;
      try { body = await readJson(req); } catch (e) {
        return send(res, e.message === 'body_too_large' ? 413 : 400, { error: e.message === 'body_too_large' ? 'body_too_large' : 'invalid_json' });
      }
      const { name, value } = body || {};
      const out = reg.setSecret(id, name, value);
      if (!out.ok) return send(res, out.error === 'not_found' ? 404 : 400, { error: out.error });
      // audit carries the name + length only — the value never enters the chain
      gw._audit({ type: 'adapter_secret_set', id, name: out.name, length: out.length });
      return send(res, 200, { ok: true, name: out.name, length: out.length });
    }

    // ── POST /v2/adapters (register) ───────────────────────────────────────
    if (!id) {
      if (req.method !== 'POST') return send(res, 405, { error: 'method_not_allowed' });
      let body;
      try { body = await readJson(req); } catch (e) {
        return send(res, e.message === 'body_too_large' ? 413 : 400, { error: e.message === 'body_too_large' ? 'body_too_large' : 'invalid_json' });
      }
      if (!body || typeof body !== 'object') return send(res, 400, { error: 'invalid_body' });
      let def;
      try {
        def = reg.register({ kind: body.kind, name: body.name, config: body.config });
      } catch (e) {
        return send(res, 400, { error: 'invalid_adapter', detail: String(e && e.message).replace(/^invalid_adapter: /, '') });
      }
      gw._audit({ type: 'adapter_registered', id: def.id, kind: def.kind, name: def.name });
      return send(res, 201, { adapter: reg.project(def) });
    }

    // ── PATCH /v2/adapters/:id (update) ────────────────────────────────────
    if (req.method === 'PATCH') {
      let body;
      try { body = await readJson(req); } catch (e) {
        return send(res, e.message === 'body_too_large' ? 413 : 400, { error: e.message === 'body_too_large' ? 'body_too_large' : 'invalid_json' });
      }
      if (!body || typeof body !== 'object') return send(res, 400, { error: 'invalid_body' });
      let def;
      try { def = reg.update(id, body); } catch (e) {
        return send(res, 400, { error: 'invalid_adapter', detail: String(e && e.message).replace(/^invalid_adapter: /, '') });
      }
      if (!def) return send(res, 404, { error: 'not_found' });
      gw._audit({ type: 'adapter_updated', id: def.id });
      return send(res, 200, { adapter: reg.project(def) });
    }

    // ── DELETE /v2/adapters/:id ────────────────────────────────────────────
    if (req.method === 'DELETE') {
      const def = reg.remove(id);
      if (!def) return send(res, 404, { error: 'not_found' });
      gw._audit({ type: 'adapter_deleted', id: def.id, kind: def.kind });
      return send(res, 200, { ok: true, id });
    }

    return send(res, 405, { error: 'method_not_allowed' });
  },
};