'use strict';
// v2 phase 2 mount: object deep-link resolver — §2.2 of docs/ux/01-FOUNDATION.md
//
//   GET /d/<DOMAIN>/o/<type>/<id>
//     Accept: application/json (API)  → bearer; resolution JSON
//     Accept: text/html      (browser)→ console shell (bookmarkable URL;
//                                        the shell re-resolves via fetch)
//
// Returns { domain, type, id, uri, panel, resolved, object|reason }.
// `panel` is the client tab id the console opens for this object.
// Unknown type / wrong domain-namespace → 404 + stable reason (spec: a
// wrong link is a 404, never a silent redirect).
//
// Canonical id prefixes (verified against the stores, 2026-09-03):
//   r_<8hex>      Run (runs.js)            — NOW
//   apr_NNNNNN    Approval                 — CONTROL
//   goal_NNNNNN   Goal (continuity)        — WORK
//   art_NNNNNN    Artifact                 — OUTPUT
//   adp_NNNN      Adapter                  — CONNECT
//   room_NNNNNN   Room                     — CHAT
//   rm_NNNNNN     RoomMessage              — CHAT
//   cs_NNNNNN     ComputerSession          — CONTROL
//   m_<8hex>      Memory fact              — BRAIN (owner-scoped)
//   sess_<8hex>   Session (transparency token) — CHAT
//   seq_NNNNNN    AuditEntry by chain seq  — CONTROL
//
// Anti-enumeration (G3): an unknown or missing session token answers with a
// single indistinguishable shape and status — the same body for "never
// existed" and "exists, can't see it". Object RBAC mirrors each owning
// surface: workers see their own bot's objects, operators see all.

const crypto = require('node:crypto');
const { send } = require('../server');
const { getRuns } = require('../runs');
const { getEngine } = require('../continuity');
const { getArtifactStore } = require('../artifacts');
const { getRoomStore } = require('../groups');
const { getAdapters } = require('../adapters-singleton');
const { getComputerStore } = require('../computer');
const { getPlanner } = require('../chat-singleton');
const { transparencyToken, secretFor } = require('./90-transparency');

const DOMAIN_RE = /^(NOW|CHAT|WORK|AGENTS|BRAIN|OUTPUT|CONTROL|CONNECT|SYSTEM)$/;
const TOKEN_RE = /^[0-9a-f]{8}$/;

function constantTimeEq(a, b) {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

function base(domain, type, id, extra) {
  return Object.assign({ domain, type, id, uri: '/d/' + domain + '/o/' + type + '/' + id }, extra);
}
function miss(type, id, domain, reason, panel) {
  return base(domain, type, id, { resolved: false, panel: panel || null, reason: reason || 'not_found' });
}

// ── per-type resolvers ───────────────────────────────────────────────────

function resolveRun(gw, bot, id) {
  const store = getRuns(gw);
  const run = store.get(id);
  if (!run) return { ok: false, reason: 'not_found' };
  if (bot.role !== 'operator' && run.bot !== bot.name) return { ok: false, reason: 'not_visible' };
  return { ok: true, object: {
    id: run.id, engine: run.engine, bot: run.bot, state: run.state,
    session: run.session || null, goalId: run.goalId || null,
    steps: (run.steps || []).length, startedAt: run.startedAt, endedAt: run.endedAt || null,
  } };
}

function resolveApproval(gw, bot, id) {
  const req = gw.approvals.get(id);
  if (!req) return { ok: false, reason: 'not_visible' }; // approvals: uniform miss (no existence oracle)
  if (bot.role !== 'operator' && req.bot !== bot.name) return { ok: false, reason: 'not_visible' };
  return { ok: true, object: {
    id: req.id, bot: req.bot, tool: req.tool, reason: req.reason || '',
    status: req.status, createdAt: req.createdAt, expiresAt: req.expiresAt,
    impact: req.impact || null,
  } };
}

function resolveGoal(gw, bot, id) {
  const eng = getEngine(gw);
  const g = eng.store.goals.get(id);
  if (!g) return { ok: false, reason: 'not_found' };
  return { ok: true, object: {
    id: g.id, bot: g.bot || null, text: g.text || '', status: g.status,
    steps: (g.steps || []).length, createdAt: g.createdAt || null,
  } };
}

function resolveArtifact(gw, bot, id) {
  const a = getArtifactStore(gw).get(id);
  if (!a) return { ok: false, reason: 'not_found' };
  if (bot.role !== 'operator' && a.bot !== bot.name) return { ok: false, reason: 'not_visible' };
  return { ok: true, object: {
    id: a.id, bot: a.bot, kind: a.kind, title: a.title, contentLength: (a.content || '').length,
    version: a.version || null, createdAt: a.createdAt || null, updatedAt: a.updatedAt || null,
  } };
}

function resolveAdapter(gw, bot, id) {
  const a = getAdapters(gw).get(id);
  if (!a) return { ok: false, reason: 'not_found' };
  if (bot.role !== 'operator') return { ok: false, reason: 'forbidden' };
  return { ok: true, object: { id: a.id, kind: a.kind, name: a.name, config: a.config || null, secrets: Object.keys(a.secrets || {}) } };
}

function resolveRoom(gw, bot, id) {
  const r = getRoomStore(gw).get(id);
  if (!r) return { ok: false, reason: 'not_found' };
  const members = ((r.members && (r.members.bots || [])) || []).concat((r.members && r.members.humans) || []);
  if (bot.role !== 'operator' && members.indexOf(bot.name) === -1 && r.createdBy !== bot.name) return { ok: false, reason: 'not_visible' };
  return { ok: true, object: { id: r.id, name: r.name || '', members, messages: (r.messages || []).length, createdBy: r.createdBy || null } };
}

function resolveRoomMessage(gw, bot, id) {
  // rm_NNNNNN ids are room-local (message number). The deep link therefore
  // carries only a local id; resolution scans visible rooms for a message
  // with that id, newest first. Misses are uniform 'not_visible' (existence
  // of messages in foreign rooms is not disclosed).
  const rooms = getRoomStore(gw).list();
  for (const r of rooms) {
    if (bot.role !== 'operator') {
      const members = ((r.members && (r.members.bots || [])) || []).concat((r.members && r.members.humans) || []);
      if (members.indexOf(bot.name) === -1 && r.createdBy !== bot.name) continue;
    }
    const msg = (r.messages || []).find((m) => m.id === id);
    if (msg) return { ok: true, object: { id: msg.id, roomId: r.id, from: msg.from || null, kind: msg.kind || null, ts: msg.ts || null, bodyLength: String(msg.body || '').length } };
  }
  return { ok: false, reason: 'not_visible' };
}

function resolveComputer(gw, bot, id) {
  const s = getComputerStore(gw).get(id);
  if (!s) return { ok: false, reason: 'not_found' };
  if (bot.role !== 'operator' && s.bot !== bot.name) return { ok: false, reason: 'not_visible' };
  return { ok: true, object: { id: s.id, bot: s.bot, label: s.label || null, state: s.state, frames: (s.frames || []).length, frameCount: s.frameCount || 0 } };
}

function resolveMemory(gw, bot, id) {
  const store = gw.memory;
  for (const [botName, data] of Object.entries(store.bots || {})) {
    const f = (data.facts || []).find((x) => x.id === id);
    if (!f) continue;
    if (bot.role !== 'operator' && bot.name !== botName) return { ok: false, reason: 'not_visible' };
    return { ok: true, object: { id: f.id, bot: botName, text: f.text, source: f.source, tags: f.tags || [], pin: Boolean(f.pin), decayAt: f.decayAt || null, createdAt: f.createdAt } };
  }
  return { ok: false, reason: 'not_found' };
}

function resolveSession(gw, bot, id) {
  // sess_<8hex> — the 8-hex is the SAME transparency token /h uses.
  const m = /^sess_([0-9a-f]{8})$/.exec(id);
  if (!m) return { ok: false, reason: 'bad_token' };
  const tok = m[1];
  const sec = secretFor(gw);
  const planner = getPlanner(gw);
  let found = null;
  for (const s of planner.listSessions()) {
    if (constantTimeEq(transparencyToken(s.name, sec), tok)) { found = s; break; }
  }
  // One indistinguishable answer for miss AND unknown-token (G3). The body
  // must NOT echo the requested token — byte-identical misses only differ
  // for an observer who already knows a valid token exists.
  if (!found) return { ok: false, reason: 'session_not_found', opaqueId: 'sess_********' };
  return { ok: true, object: { id: 'sess_' + tok, token: tok, name: found.name, turns: found.turns, source: 'planner' } };
}

function resolveAuditEntry(gw, bot, id) {
  const m = /^seq_(\d+)$/.exec(id);
  if (!m) return { ok: false, reason: 'bad_seq' };
  const seq = Number(m[1]);
  const entry = (gw.chain.entries || []).find((e) => e.seq === seq);
  if (!entry) return { ok: false, reason: 'not_found' };
  const p = entry.payload || {};
  return { ok: true, object: {
    id: 'seq_' + seq, seq, ts: entry.ts, hash: entry.hash,
    type: p.type || null, bot: p.bot || null, tool: p.tool || null, decision: p.decision || null,
  } };
}

// canonical type → { panel, resolve } + owning domain (wrong namespace = 404)
const TYPES = {
  run:        { panel: 'console',    domain: 'NOW',     resolve: resolveRun },
  approval:   { panel: 'console',    domain: 'CONTROL', resolve: resolveApproval },
  goal:       { panel: 'goals',      domain: 'WORK',    resolve: resolveGoal },
  artifact:   { panel: 'artifacts',  domain: 'OUTPUT',  resolve: resolveArtifact },
  adapter:    { panel: 'integrations', domain: 'CONNECT', resolve: resolveAdapter },
  room:       { panel: 'rooms',      domain: 'CHAT',    resolve: resolveRoom },
  message:    { panel: 'rooms',      domain: 'CHAT',    resolve: resolveRoomMessage },
  computersession: { panel: 'computer', domain: 'CONTROL', resolve: resolveComputer },
  memory:     { panel: 'history',    domain: 'BRAIN',   resolve: resolveMemory },
  session:    { panel: 'history',    domain: 'CHAT',    resolve: resolveSession },
  auditentry: { panel: 'history',    domain: 'CONTROL', resolve: resolveAuditEntry },
};

const DEEPLINK_HTML = '<!doctype html><meta charset="utf-8"><title>Trust Gateway</title>' +
  '<p style="font:13px ui-monospace,monospace;color:#c9d1d9;background:#0b0e14;padding:20px">' +
  'deep link — the console resolves this object automatically.</p>';

module.exports = {
  name: 'v2-deeplink',
  method: 'GET',
  path: /^\/d\//,
  // decided in-handler: browser navigations get the (public) shell; API
  // calls require bearer. No secrets are ever returned pre-auth.
  auth: 'none',
  handle: async (gw, req, res, ctx) => {
    const accept = String(req.headers.accept || '');
    const isHtml = accept.includes('text/html');
    const parts = /^\/d\/([^/]+)\/o\/([^/]+)\/([^/?#]+)$/.exec(ctx.url.pathname);

    if (isHtml) {
      if (gw.staticDir) return gw._serveStatic(res, 'index.html');
      return send(res, 200, null, { html: DEEPLINK_HTML });
    }

    const bot = gw._auth(req);
    if (!bot) return send(res, 401, { error: 'unauthorized' });

    if (!parts) return send(res, 404, miss('unknown', null, null, 'malformed'));
    const domain = parts[1];
    const type = parts[2];
    const id = decodeURIComponent(parts[3]);
    if (!DOMAIN_RE.test(domain)) return send(res, 404, miss('unknown', id, domain, 'unknown_domain'));
    const spec = TYPES[type];
    if (!spec) return send(res, 404, miss('unknown', id, domain, 'unknown_type'));
    if (spec.domain !== domain) return send(res, 404, miss(type, id, domain, 'wrong_domain', spec.panel));

    let out;
    try { out = spec.resolve(gw, bot, id); } catch { out = { ok: false, reason: 'store_error' }; }
    if (!out.ok) {
      const body = miss(type, id, domain, out.reason, spec.panel);
      if (out.opaqueId) { body.id = out.opaqueId; body.uri = '/d/' + domain + '/o/' + type + '/' + out.opaqueId; }
      return send(res, 404, body);
    }
    return send(res, 200, base(domain, type, id, { resolved: true, panel: spec.panel, object: out.object }));
  },
  TYPES,
};
