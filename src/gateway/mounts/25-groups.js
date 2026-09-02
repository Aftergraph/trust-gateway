'use strict';
// v2 mount: W2 group rooms.
//   GET    /v2/rooms               — list rooms (summary projection, no secrets)
//   POST   /v2/rooms               — create a room {name, bots, humans, turnLimit, msgCap}
//   GET    /v2/rooms/:id           — room detail incl. message transcript
//   DELETE /v2/rooms/:id           — drop a room (creator or operator only)
//   POST   /v2/rooms/:id/messages  — deliver an A2A envelope {kind, body, mentions, target, chain, replyTo}
//
// auth:'bearer' — the mount runner authenticated ctx.bot before we run.
// One mount object with method '*' + a RegExp path: the runner's match()
// supports both, and the platform rule is "mount files, never server.js".
//
// Impersonation rule: a bot may only post with from === its own name.
// Members are projected as {name, role, capabilities} for bots (ABI rule 5 —
// tokens NEVER leave gw.bots) and plain strings for humans.

const { send, readBody } = require('../server');
const { getRoomStore } = require('../groups');

const PATH_RE = /^\/v2\/rooms(?:\/([^/]+)(?:\/messages)?)?$/;

function segments(pathname) {
  return pathname.split('/').filter(Boolean); // ['v2','rooms'] | +[id] | +[id,'messages']
}

function roomSummary(room) {
  return {
    id: room.id, name: room.name, members: room.members,
    turnLimit: room.turnLimit, msgCap: room.msgCap,
    messageCount: room.messages.length, createdAt: room.createdAt, createdBy: room.createdBy,
  };
}

async function parseBody(req, res) {
  let raw;
  try { raw = await readBody(req); } catch { send(res, 413, { error: 'body_too_large' }); return null; }
  try { return JSON.parse(raw || '{}'); } catch { send(res, 400, { error: 'invalid_json' }); return null; }
}

async function createRoom(gw, req, res, ctx) {
  const body = await parseBody(req, res);
  if (body === null) return;
  let room;
  try {
    const bots = Array.isArray(body.bots) ? body.bots.slice() : [];
    if (body.autoAddCreator !== false && !bots.includes(ctx.bot.name)) bots.push(ctx.bot.name);
    room = getRoomStore(gw).create({
      name: body.name,
      bots,
      humans: body.humans,
      turnLimit: body.turnLimit,
      msgCap: body.msgCap,
      createdBy: ctx.bot.name,
    });
  } catch (e) {
    const code = e && e.code ? String(e.code).replace(/^room: /, '') : 'create_failed';
    return send(res, 400, { error: code });
  }
  send(res, 201, { ok: true, room: roomSummary(room) });
}

function listRooms(gw, req, res, ctx) {
  const rooms = getRoomStore(gw).list().map(roomSummary);
  send(res, 200, { ok: true, rooms });
}

function getRoom(gw, req, res, ctx, roomId) {
  const room = getRoomStore(gw).get(roomId);
  if (!room) return send(res, 404, { error: 'not_found' });
  send(res, 200, { ok: true, room: { ...roomSummary(room), messages: room.messages } });
}

function deleteRoom(gw, req, res, ctx, roomId) {
  const store = getRoomStore(gw);
  const room = store.get(roomId);
  if (!room) return send(res, 404, { error: 'not_found' });
  const isOperator = ctx.bot && (ctx.bot.role === 'operator'
    || (Array.isArray(ctx.bot.capabilities) && (ctx.bot.capabilities.includes('approval.decide') || ctx.bot.capabilities.includes('*'))));
  if (room.createdBy !== ctx.bot.name && !isOperator) {
    return send(res, 403, { error: 'creator_or_operator_required' });
  }
  store.remove(roomId, ctx.bot.name);
  send(res, 200, { ok: true, deleted: roomId });
}

async function postMessage(gw, req, res, ctx, roomId) {
  const body = await parseBody(req, res);
  if (body === null) return;
  const from = typeof body.from === 'string' && body.from ? body.from : ctx.bot.name;
  if (from !== ctx.bot.name) return send(res, 403, { error: 'no_impersonation' });
  let out;
  try {
    out = await getRoomStore(gw).deliver(roomId, {
      from,
      kind: typeof body.kind === 'string' ? body.kind : 'message',
      body: body.body,
      mentions: body.mentions,
      target: body.target,
      chain: body.chain,
      replyTo: body.replyTo,
    });
  } catch (e) {
    const code = e && e.code ? String(e.code).replace(/^room: /, '') : 'deliver_failed';
    return send(res, 400, { error: code });
  }
  if (!out.ok) {
    if (out.error === 'not_found') return send(res, 404, out);
    if (out.error === 'msg_cap_reached' || out.error === 'turn_limit_reached') return send(res, 409, out);
    return send(res, 400, out);
  }
  if (out.proposal && out.proposal.decision === 'deny') {
    return send(res, 403, { ok: false, error: 'proposal_denied', reason: out.proposal.reason, message: out.message });
  }
  send(res, 201, {
    ok: true,
    message: out.message,
    deliveredTo: out.deliveredTo,
    proposal: out.proposal || null,
  });
}

module.exports = {
  name: 'v2-groups',
  method: '*',
  path: PATH_RE,
  auth: 'bearer',
  handle: async (gw, req, res, ctx) => {
    const seg = segments(ctx.url.pathname);
    const roomId = seg[2];
    const isMessages = seg[3] === 'messages';
    if (req.method === 'GET' && !roomId) return listRooms(gw, req, res, ctx);
    if (req.method === 'POST' && !roomId) return createRoom(gw, req, res, ctx);
    if (roomId && isMessages && req.method === 'POST') return postMessage(gw, req, res, ctx, roomId);
    if (roomId && !isMessages && req.method === 'GET') return getRoom(gw, req, res, ctx, roomId);
    if (roomId && !isMessages && req.method === 'DELETE') return deleteRoom(gw, req, res, ctx, roomId);
    return send(res, 405, { error: 'method_not_allowed' });
  },
};
