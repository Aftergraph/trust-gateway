'use strict';
// B1 mount: POST /v2/rooms/:id/attach — fil-upload i rooms → artifacts.
//
// Kontrakt:
//   body: { name, content, kind }  (kind ∈ doc|code|image-ref; max 128 KB —
//          samme loft som ArtifactStore.MAX_CONTENT)
//   1) Opretter artifact via tenant-scoped ArtifactStore (bot = ctx.bot.name)
//   2) Poster attachment-envelope i tråden: {kind:'message', body:{attachment:
//      {artifactId, title, name, size}}} — struktureret body (bodyText
//      stringify'er objekter; UI renderer attachment-kort)
//   3) Audit: room_attach {roomId, bot, artifactId, size} — aldrig indhold
//   Fail-closed: 404 ukendt room, 403 non-member, 400 ugyldig kind/tom/for
//   stor content/missing name. Ingen syntetiske data.
//
// Uses: getRoomStore (groups), getArtifactStore + scoped store (40-artifacts
// konvention), resolveTenant, enforceQuotas.

const { send, readBody } = require('../server');
const { getRoomStore } = require('../groups');
const { ArtifactStore, KINDS, getArtifactStore } = require('../artifacts');
const { resolveTenant } = require('../tenant-resolve');
const { enforceQuotas, scopedStore, scopeDir, tenantAuditTag } = require('../tenant-scope');

const PATH_RE = /^\/v2\/rooms\/([^/]+)\/attach$/;
const ATTACH_KINDS = new Set(['doc', 'code', 'image-ref']);
const MAX_CONTENT = 128 * 1024; // ArtifactStore.MAX_CONTENT-loftet

function artifactStoreFor(gw, tenant) {
  if (!tenant || tenant.id === 'main') return getArtifactStore(gw);
  return scopedStore(gw, `artifacts:${tenant.id}`, () => new ArtifactStore({
    file: require('node:path').join(scopeDir(null, gw, tenant.id, 'artifacts'), 'artifacts.json'),
    now: () => (gw && gw.now ? gw.now() : Date.now()),
  }));
}

module.exports = {
  name: 'rooms-attach',
  method: 'POST',
  path: PATH_RE,
  auth: 'bearer',
  handle: async (gw, req, res, ctx) => {
    const m = (req.url || '').match(PATH_RE);
    const roomId = m ? decodeURIComponent(m[1]) : null;
    if (!roomId) return send(res, 400, { error: 'bad_path' });

    let raw = '';
    req.on('data', (c) => { raw += c; if (raw.length > 256 * 1024) req.destroy(); });
    await new Promise((r) => req.on('end', r));
    let body;
    try { body = JSON.parse(raw || '{}'); } catch { return send(res, 400, { error: 'invalid_json' }); }

    const name = typeof body.name === 'string' ? body.name.trim() : '';
    const content = typeof body.content === 'string' ? body.content : '';
    const kind = body.kind;
    if (!name || name.length > 200) return send(res, 400, { error: 'name_required' });
    if (!ATTACH_KINDS.has(kind)) return send(res, 400, { error: 'invalid_kind', allowed: [...ATTACH_KINDS] });
    if (!content.length) return send(res, 400, { error: 'content_required' });
    if (Buffer.byteLength(content) > MAX_CONTENT) return send(res, 400, { error: 'content_too_large', max: MAX_CONTENT });

    const bot = ctx.bot && ctx.bot.name;
    const room = getRoomStore(gw).get(roomId);
    if (!room) return send(res, 404, { error: 'not_found' });
    if (!bot || !room.members.bots.includes(bot)) return send(res, 403, { error: 'not_member' });

    const { tenant } = resolveTenant(req, gw);
    if (enforceQuotas(gw, tenant, res)) return;

    // 1) artifact (tenant-scoped, samme konvention som 40-artifacts)
    const store = artifactStoreFor(gw, tenant);
    const out = store.create({
      kind, title: name, content, bot,
      sessionRef: `room_${roomId}`,
    });
    if (!out.ok) return send(res, 400, { error: out.error, allowedKinds: KINDS });
    const art = out.artifact;

    // 2) attachment-envelope i tråden (struktureret body)
    const size = Buffer.byteLength(content);
    const delivered = await getRoomStore(gw).deliver(roomId, {
      from: bot,
      kind: 'message',
      body: { attachment: { artifactId: art.id, title: art.title, name, size, kind } },
    });
    if (!delivered.ok) {
      if (delivered.error === 'not_found') return send(res, 404, { error: 'not_found' });
      return send(res, 400, { error: delivered.error });
    }

    gw._audit({ type: 'room_attach', roomId, bot, artifactId: art.id, size });
    send(res, 201, { ok: true, artifactId: art.id, messageId: delivered.message && delivered.message.id, size });
  },
};
