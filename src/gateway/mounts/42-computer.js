'use strict';
// v2 mount: Live Computer sessions (W5) — governed view of a bot at work.
//
// Router mount on the /v2/computer prefix (method '*', RegExp path), same
// shape as 40-artifacts: auth is performed in-handler — Bearer for API
// calls, plus ?token= for SSE (EventSource can't set headers). Failed auth
// is audited (auth_rejected) like the mount runner does.
//
// Routes:
//   POST /v2/computer                 open session       → audit computer_session_created
//   GET  /v2/computer                 list (?bot=&state=)
//   GET  /v2/computer/:id             session + frames + chain verification
//   POST /v2/computer/:id/frames      append frame       → audit computer_frame
//                                     (refusals/raw-args → audit computer_frame_denied)
//   POST /v2/computer/:id/control     {action:'takeover'|'release'|'set',state?}
//                                     operator-only; → audit control_taken /
//                                     control_released; refusals audited too
//   GET  /v2/computer/:id/stream      SSE: replay retained frames, then live
//                                     `event: computer` frames.
//
// Frames are summaries ONLY — the store hard-rejects any raw args keys.
// Every appended frame is hash-chained (prevHash→entryHash) and its
// entryHash is sealed into the audit chain as well.

const crypto = require('node:crypto');
const { send, readBody, canApprove } = require('../server');
const { getHub } = require('../events');
const { ComputerStore, KINDS, getComputerStore } = require('../computer');

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

function project(s) {
  return {
    id: s.id, bot: s.bot, label: s.label, state: s.state,
    frameCount: s.frameCount, retained: s.frames.length,
    control: s.control ? { heldBy: s.control.heldBy, since: s.control.since } : null,
    createdAt: s.createdAt, updatedAt: s.updatedAt,
  };
}

module.exports = {
  name: 'v2-computer',
  method: '*',
  path: /^\/v2\/computer(?:\/.*)?$/,
  auth: 'none',
  handle: async (gw, req, res, ctx) => {
    const pathname = ctx.url.pathname;
    try {
      return await route(gw, req, res, ctx, pathname);
    } catch (e) {
      if (String(e && e.message) === 'body_too_large') return send(res, 413, { error: 'body_too_large' });
      if (String(e && e.message).includes('fail closed'))
        return send(res, 503, { error: 'computer_store_unavailable' }); // fail closed, never half-serve
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
  const seg = pathname.split('/').filter(Boolean); // ['v2','computer',id?,sub?]
  const store = getComputerStore(gw);
  const method = req.method;

  // ── collection ──
  if (seg.length === 2 && method === 'POST') {
    let body;
    try { body = await bodyJson(req); } catch (e) { return parseOr400(res, e); }
    const out = store.create({ bot: bot.name, label: body.label ?? null });
    if (!out.ok) return send(res, 400, { error: out.error });
    gw._audit({
      type: 'computer_session_created', sessionId: out.session.id,
      bot: bot.name, label: out.session.label,
    });
    getHub(gw).broadcast('computer', { action: 'session', sessionId: out.session.id, session: project(out.session) });
    return send(res, 201, { session: project(out.session) });
  }
  if (seg.length === 2 && method === 'GET') {
    const q = ctx.url.searchParams;
    const items = store.list({ bot: q.get('bot') || null, state: q.get('state') || null });
    return send(res, 200, { sessions: items.map(project) });
  }

  if (seg.length < 3) return send(res, 404, { error: 'not_found' });
  const id = decodeURIComponent(seg[2]);
  const sub = seg.length === 4 ? seg[3] : '';

  // ── SSE stream: replay + live ──
  if (sub === 'stream' && method === 'GET' && seg.length === 4) {
    const s = store.get(id);
    if (!s) return send(res, 404, { error: 'not_found' });
    const v = store.verifyChain(s);
    sseOpen(res, {
      session: project(s),
      chain: v,
    });
    // Replay: every retained frame, oldest first (summaries — never raw args).
    for (const f of s.frames) sseEvent(res, 'computer', { action: 'frame', sessionId: id, frame: f });
    // Then live frames for THIS session.
    const onFrame = ({ session, frame }) => {
      if (session.id !== id) return;
      sseEvent(res, 'computer', { action: 'frame', sessionId: id, frame });
    };
    const onState = ({ session, from, to }) => {
      if (session.id !== id) return;
      sseEvent(res, 'computer', { action: 'state', sessionId: id, from, to });
    };
    store.on('frame', onFrame);
    store.on('state', onState);
    res.on('close', () => { store.off('frame', onFrame); store.off('state', onState); });
    return undefined; // stream stays open
  }

  // ── item ──
  if (seg.length === 3 && method === 'GET') {
    const s = store.get(id);
    if (!s) return send(res, 404, { error: 'not_found' });
    return send(res, 200, { session: project(s), frames: s.frames, chain: store.verifyChain(s) });
  }

  // Only the session's bot or an operator may write to it.
  const mayWrite = (s) => s.bot === bot.name || canApprove(bot);

  if (sub === 'frames' && method === 'POST' && seg.length === 4) {
    const s = store.get(id);
    if (!s) return send(res, 404, { error: 'not_found' });
    let body;
    try { body = await bodyJson(req); } catch (e) { return parseOr400(res, e); }
    if (!mayWrite(s)) {
      gw._audit({ type: 'computer_frame_denied', sessionId: id, bot: bot.name, owner: s.bot, reason: 'not_owner' });
      return send(res, 403, { error: 'forbidden' });
    }
    const out = store.appendFrame(id, body);
    if (!out.ok) {
      // Refusals are on the record — including raw-args attempts.
      gw._audit({ type: 'computer_frame_denied', sessionId: id, bot: bot.name, reason: out.error });
      const status = out.error === 'raw_args_forbidden' ? 422 : out.error === 'session_done' ? 409 : 400;
      return send(res, status, { error: out.error, allowedKinds: KINDS });
    }
    const f = out.frame;
    gw._audit({
      type: 'computer_frame', sessionId: id, index: f.index, kind: f.kind,
      summary: f.summary, ref: f.ref, prevHash: f.prevHash, entryHash: f.entryHash,
    });
    getHub(gw).broadcast('computer', { action: 'frame', sessionId: id, frame: f });
    return send(res, 201, { frame: f, chain: store.verifyChain(store.get(id)) });
  }

  if (sub === 'control' && method === 'POST' && seg.length === 4) {
    const s = store.get(id);
    if (!s) return send(res, 404, { error: 'not_found' });
    let body;
    try { body = await bodyJson(req); } catch (e) { return parseOr400(res, e); }
    // Control is an operator action (RBAC), and refusals are audited.
    if (!canApprove(bot)) {
      gw._audit({ type: 'computer_control_denied', sessionId: id, bot: bot.name, action: String(body.action ?? ''), reason: 'operator_required' });
      return send(res, 403, { error: 'operator_required' });
    }
    const action = body.action;
    if (action === 'takeover') {
      const out = store.takeover(id, bot.name);
      if (!out.ok) {
        gw._audit({ type: 'computer_control_denied', sessionId: id, bot: bot.name, action, reason: out.error });
        const status = out.error === 'not_found' ? 404 : 409;
        return send(res, status, { error: out.error });
      }
      gw._audit({ type: 'control_taken', sessionId: id, by: bot.name, from: out.from });
      getHub(gw).broadcast('computer', { action: 'control', sessionId: id, control: 'taken', by: bot.name });
      return send(res, 200, { session: project(out.session) });
    }
    if (action === 'release') {
      const out = store.release(id, bot.name);
      if (!out.ok) {
        gw._audit({ type: 'computer_control_denied', sessionId: id, bot: bot.name, action, reason: out.error });
        const status = out.error === 'not_found' ? 404 : 409;
        return send(res, status, { error: out.error });
      }
      gw._audit({ type: 'control_released', sessionId: id, by: bot.name, to: out.to });
      getHub(gw).broadcast('computer', { action: 'control', sessionId: id, control: 'released', by: bot.name });
      return send(res, 200, { session: project(out.session) });
    }
    if (action === 'set') {
      const out = store.setState(id, body.state);
      if (!out.ok) {
        gw._audit({ type: 'computer_control_denied', sessionId: id, bot: bot.name, action, reason: out.error });
        const status = out.error === 'not_found' ? 404 : out.error === 'bad_transition' ? 409 : 400;
        return send(res, status, { error: out.error, from: out.from, to: out.to });
      }
      if (!out.unchanged) {
        gw._audit({ type: 'computer_state_changed', sessionId: id, by: bot.name, from: out.from, to: out.to });
        getHub(gw).broadcast('computer', { action: 'state', sessionId: id, from: out.from, to: out.to });
      }
      return send(res, 200, { session: project(out.session) });
    }
    gw._audit({ type: 'computer_control_denied', sessionId: id, bot: bot.name, action: String(action ?? ''), reason: 'bad_action' });
    return send(res, 400, { error: 'bad_action', allowed: ['takeover', 'release', 'set'] });
  }

  return send(res, 404, { error: 'not_found' });
}
