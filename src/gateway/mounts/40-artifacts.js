'use strict';
// v2 mount: Artifacts (W5) — code/docs/image-refs/reports the workforce ships.
//
// One mount file = one exported mount, so this is a small router on the
// /v2/artifacts prefix (method '*', RegExp path). Auth is declared 'none'
// and performed IN-HANDLER: regular calls use `Authorization: Bearer`, and
// SSE streams additionally accept `?token=` because browser EventSource
// cannot set headers. Every failed auth is audited (auth_rejected) exactly
// like the mount runner does.
//
// Routes:
//   POST /v2/artifacts            create artifact (v1)      → audit artifact_created
//   GET  /v2/artifacts            list (?kind=&bot=&sessionRef=)
//   GET  /v2/artifacts/:id        full artifact + versions
//   PUT  /v2/artifacts/:id        new version               → audit artifact_updated
//   GET  /v2/artifacts/:id/stream SSE follow-along: replay every version,
//                                 then live `event: artifact` updates.
//
// Live updates ALSO hit the shared hub as `event: artifact` broadcasts
// (projections only — no content bodies on the global firehose).

const crypto = require('node:crypto');
const path = require('node:path');
const { send, readBody, canApprove } = require('../server');
const { getHub } = require('../events');
const { ArtifactStore, KINDS, getArtifactStore } = require('../artifacts');
const { resolveTenant } = require('../tenant-resolve');
const { scopeDir, scopedStore, tenantAuditTag } = require('../tenant-scope');

// FS-E1 slice 2: tenant-scoped artifacts. A non-main tenant gets its own
// ArtifactStore over <TG_DATA_DIR>/data/tenants/<id>/artifacts/artifacts.json;
// the main tenant keeps the shared singleton (TG_ARTIFACTS_FILE / default
// data/artifacts.json) byte-identically.
function artifactStoreFor(gw, tenant) {
  if (!tenant || tenant.id === 'main') return getArtifactStore(gw);
  return scopedStore(gw, `artifacts:${tenant.id}`, () => new ArtifactStore({
    file: path.join(scopeDir(null, gw, tenant.id, 'artifacts'), 'artifacts.json'),
    now: () => (gw && gw.now ? gw.now() : Date.now()),
  }));
}

function authBot(gw, req, url) {
  const h = req.headers['authorization'] || '';
  const m = /^Bearer\s+(.+)$/i.exec(h);
  const token = m ? m[1] : (url.searchParams.get('token') || '');
  if (!token) return null;
  for (const [name, bot] of Object.entries(gw.bots)) {
    if (!bot || !bot.token) continue;
    const a = Buffer.from(String(bot.token));
    const b = Buffer.from(String(token));
    if (a.length === b.length && crypto.timingSafeEqual(a, b)) return { name, ...bot };
  }
  return null;
}

async function bodyJson(req) {
  const raw = await readBody(req);
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    const err = new Error('invalid_json');
    err.invalidJson = true;
    throw err;
  }
}

const parseOr400 = (res, e) =>
  e.invalidJson ? send(res, 400, { error: 'invalid_json' }) : (() => { throw e; })();

function sseOpen(res, hello) {
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache, no-transform',
    'connection': 'keep-alive',
    'x-accel-buffering': 'no',
  });
  res.write('retry: 3000\n\n');
  res.write(`event: hello\ndata: ${JSON.stringify(hello)}\n\n`);
}
const sseEvent = (res, type, data) => {
  try { res.write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`); } catch { /* dead socket */ }
};

module.exports = {
  name: 'v2-artifacts',
  method: '*',
  path: /^\/v2\/artifacts(?:\/.*)?$/,
  auth: 'none',
  handle: async (gw, req, res, ctx) => {
    const pathname = ctx.url.pathname;
    try {
      return await route(gw, req, res, ctx, pathname);
    } catch (e) {
      if (String(e && e.message) === 'body_too_large') return send(res, 413, { error: 'body_too_large' });
      if (String(e && e.message).includes('unparseable') || String(e && e.message).includes('fail closed'))
        return send(res, 503, { error: 'artifact_store_unavailable' }); // fail closed, never half-serve
      return send(res, 500, { error: 'internal_error' });
    }
  },
};

async function route(gw, req, res, ctx, pathname) {
  const bot = authBot(gw, req, ctx.url);
  if (!bot) {
    gw._audit({ type: 'auth_rejected', path: pathname });
    return send(res, 401, { error: 'unauthorized' });
  }
  // FS-E1 slice 2: tenant resolve AFTER bearer auth (the prefix is a claim,
  // never an auth decision). Unknown/disabled tenant → 404 (anti-enumeration).
  req.bot = bot;
  const { tenant } = resolveTenant(req, gw);
  if (!tenant) return send(res, 404, { error: 'not_found' });
  const tag = tenantAuditTag(tenant);
  const seg = pathname.split('/').filter(Boolean); // ['v2','artifacts',id?,sub?]
  const store = artifactStoreFor(gw, tenant);
  const method = req.method;

  // ── collection ──
  if (seg.length === 2 && method === 'POST') {
    let body;
    try { body = await bodyJson(req); } catch (e) { return parseOr400(res, e); }
    const out = store.create({
      kind: body.kind, title: body.title, content: body.content,
      bot: bot.name, sessionRef: body.sessionRef ?? null,
    });
    if (!out.ok) return send(res, 400, { error: out.error, allowedKinds: KINDS });
    const art = out.artifact;
    gw._audit({
      type: 'artifact_created', artifactId: art.id, kind: art.kind,
      bot: art.bot, version: 1, title: art.title, sessionRef: art.sessionRef,
      ...tag,
    });
    getHub(gw).broadcast('artifact', {
      action: 'created', artifact: ArtifactStore.project(art),
      version: { v: 1, ts: art.versions[0].ts, bot: art.versions[0].bot, hash: art.versions[0].hash },
    });
    return send(res, 201, { artifact: art });
  }
  if (seg.length === 2 && method === 'GET') {
    const q = ctx.url.searchParams;
    const items = store.list({ kind: q.get('kind') || null, bot: q.get('bot') || null, sessionRef: q.get('sessionRef') || null });
    return send(res, 200, { artifacts: items.map(ArtifactStore.project) });
  }

  // ── item ──
  if (seg.length < 3) return send(res, 404, { error: 'not_found' });
  const id = decodeURIComponent(seg[2]);
  const isStream = seg.length === 4 && seg[3] === 'stream';

  if (isStream && method === 'GET') {
    const art = store.get(id);
    if (!art) return send(res, 404, { error: 'not_found' });
    sseOpen(res, { artifact: ArtifactStore.project(art) });
    // Follow-along replay: every historical version, oldest first.
    for (const v of art.versions) {
      sseEvent(res, 'artifact', { action: 'replay', artifactId: id, version: v });
    }
    // Then live.
    const onUpd = ({ action, artifact, version }) => {
      if (artifact.id !== id) return;
      sseEvent(res, 'artifact', { action, artifactId: id, version });
    };
    store.on('update', onUpd);
    res.on('close', () => store.off('update', onUpd));
    return undefined; // stream stays open
  }

  if (seg.length === 3 && method === 'GET') {
    const art = store.get(id);
    if (!art) return send(res, 404, { error: 'not_found' });
    return send(res, 200, { artifact: art });
  }

  if (seg.length === 3 && method === 'PUT') {
    const art = store.get(id);
    if (!art) return send(res, 404, { error: 'not_found' });
    // Only the creating bot — or an operator — may ship a new version.
    if (art.bot !== bot.name && !canApprove(bot)) {
      gw._audit({ type: 'artifact_update_denied', artifactId: id, bot: bot.name, owner: art.bot, ...tag });
      return send(res, 403, { error: 'forbidden' });
    }
    let body;
    try { body = await bodyJson(req); } catch (e) { return parseOr400(res, e); }
    const out = store.putVersion(id, { bot: bot.name, title: body.title ?? null, content: body.content ?? null });
    if (!out.ok) {
      const status = out.error === 'not_found' ? 404 : 400;
      return send(res, status, { error: out.error });
    }
    gw._audit({
      type: 'artifact_updated', artifactId: id, bot: bot.name,
      version: out.version.v, title: out.version.title,
      ...tag,
    });
    getHub(gw).broadcast('artifact', {
      action: 'updated', artifact: ArtifactStore.project(out.artifact),
      version: { v: out.version.v, ts: out.version.ts, bot: out.version.bot, hash: out.version.hash },
    });
    return send(res, 200, { artifact: out.artifact, version: out.version });
  }

  return send(res, 404, { error: 'not_found' });
}
