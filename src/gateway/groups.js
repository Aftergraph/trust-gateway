'use strict';
// Trust Gateway v2 — W2: group rooms (humans + multiple bots).
//
// A Room is {id, name, members:{bots[], humans[]}, turnLimit=3, msgCap=10,
// messages[]} where every message is an A2A-compatible envelope
//   {from, to:<roomId>, kind:'message'|'proposal'|'handoff', body, ...}
//
// Governance invariants (PLATFORM-ABI):
//   • Durable state: own JSON file (data/rooms.json), atomic tmp+rename,
//     mode 0600, refuse-to-load-on-corrupt (fail closed) — approvals.js pattern.
//   • Every stateful decision goes through gw._audit(payload): plain JSON
//     payloads, no undefined values.
//   • Rooms NEVER persist proposal args (secrets) — only the tool name and
//     argsLength; args park in the approvals store like everywhere else.
//   • Caps are enforced BEFORE persistence: msgCap bounds total messages,
//     turnLimit bounds bot-authored messages (a "turn"). Hitting a cap is
//     audited as room_limit_hit and the post is refused.
//   • Handoff chains are VERIFIED, not trusted: every consecutive pair in the
//     claimed chain must be backed by an actual handoff message in the room,
//     every link must be a bot member, no repeats, depth capped.
//   • Proposals route through policy classify/decide + the approvals store;
//     dispatch happens only on 'allow' (governed hop), never on untrusted text.
//   • SSE: hub.broadcast('room', payload) for created / message / handoff /
//     limit events.

const fs = require('node:fs');
const path = require('node:path');
const { classify, decide } = require('./policy');
const { getHub } = require('./events');

const DEFAULT_TURN_LIMIT = 3;
const DEFAULT_MSG_CAP = 10;
const MAX_HANDOFF_DEPTH = 8;
const MAX_BODY_LEN = 4000;
const MAX_MEMBERS_PER_SIDE = 64;

const KINDS = new Set(['message', 'proposal', 'handoff', 'assistant']);

function err(code) {
  const e = new Error(`room: ${code}`);
  e.code = code;
  return e;
}

function normNames(arr, field) {
  if (arr === undefined || arr === null) return [];
  if (!Array.isArray(arr)) throw err(`${field}_must_be_array`);
  if (arr.length > MAX_MEMBERS_PER_SIDE) throw err(`${field}_too_many`);
  const out = [];
  for (const v of arr) {
    if (typeof v !== 'string' || !v.trim() || v.length > 64) throw err(`${field}_entries_invalid`);
    const s = v.trim();
    if (!out.includes(s)) out.push(s);
  }
  return out;
}

function normLimit(v, fallback, cap) {
  if (v === undefined || v === null) return fallback;
  if (!Number.isInteger(v) || v < 1 || v > cap) throw err('limit_must_be_integer');
  return v;
}

class RoomStore {
  constructor({ file = null, now = () => Date.now(), gateway = null } = {}) {
    this.file = file;
    this.now = now;
    this.gateway = gateway;
    this.rooms = new Map(); // id -> room
    this.auditTrail = []; // used when no gateway is injected (unit tests)
    this._next = 1;
    if (file && fs.existsSync(file)) this._load();
  }

  // ── storage (atomic + 0600 + fail-closed) ─────────────────────────────

  _load() {
    let obj;
    try {
      obj = JSON.parse(fs.readFileSync(this.file, 'utf8'));
    } catch {
      throw new Error('rooms: file unparseable — refusing to load (fail closed)');
    }
    if (!obj || typeof obj !== 'object' || !Array.isArray(obj.rooms)) {
      throw new Error('rooms: file must contain a rooms array');
    }
    for (const r of obj.rooms) {
      if (!r || typeof r.id !== 'string' || !r.members || !Array.isArray(r.messages)) {
        throw new Error('rooms: entry missing id/members/messages');
      }
      this.rooms.set(r.id, r);
      const n = Number(r.id.replace(/^room_/, ''));
      if (Number.isFinite(n) && n >= this._next) this._next = n + 1;
    }
  }

  _save() {
    if (!this.file) return;
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = this.file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify({ version: 1, rooms: [...this.rooms.values()] }) + '\n');
    fs.renameSync(tmp, this.file);
    try { fs.chmodSync(this.file, 0o600); } catch { /* best effort */ }
  }

  // ── audit + SSE ────────────────────────────────────────────────────────

  _audit(payload) {
    if (this.gateway && typeof this.gateway._audit === 'function') {
      return this.gateway._audit(payload);
    }
    this.auditTrail.push(payload);
    return null;
  }

  _broadcast(payload) {
    if (!this.gateway) return;
    try { getHub(this.gateway).broadcast('room', payload); } catch { /* hub optional */ }
  }

  // ── room lifecycle ─────────────────────────────────────────────────────

  create({ name, bots = [], humans = [], turnLimit, msgCap, createdBy = null } = {}) {
    if (typeof name !== 'string' || !name.trim() || name.length > 120) throw err('name_invalid');
    const botList = normNames(bots, 'bots');
    const humanList = normNames(humans, 'humans');
    for (const b of botList) if (humanList.includes(b)) throw err('member_both_bot_and_human');
    const tl = normLimit(turnLimit, DEFAULT_TURN_LIMIT, 1000);
    const mc = normLimit(msgCap, DEFAULT_MSG_CAP, 10000);
    if (this.gateway && this.gateway.bots) {
      for (const b of botList) {
        if (!this.gateway.bots[b]) throw err(`unknown_bot:${b}`);
      }
    }
    const id = `room_${String(this._next++).padStart(6, '0')}`;
    const room = {
      id,
      name: name.trim(),
      members: { bots: botList, humans: humanList },
      turnLimit: tl,
      msgCap: mc,
      messages: [],
      createdAt: this.now(),
      createdBy,
    };
    this.rooms.set(id, room);
    this._save();
    this._audit({
      type: 'room_created', roomId: id, name: room.name,
      bots: botList, humans: humanList, turnLimit: tl, msgCap: mc, createdBy,
    });
    this._broadcast({ event: 'room_created', roomId: id, name: room.name, bots: botList, humans: humanList });
    return room;
  }

  get(id) { return this.rooms.get(id) || null; }
  list() { return [...this.rooms.values()]; }

  remove(id, by = null) {
    const room = this.rooms.get(id);
    if (!room) return false;
    this.rooms.delete(id);
    this._save();
    this._audit({ type: 'room_deleted', roomId: id, name: room.name, by });
    this._broadcast({ event: 'room_deleted', roomId: id });
    return true;
  }

  // ── derived counts ─────────────────────────────────────────────────────

  _botTurns(room) {
    const bots = new Set(room.members.bots);
    let n = 0;
    for (const m of room.messages) if (bots.has(m.from)) n++;
    return n;
  }

  _mentionsOf(body) {
    if (typeof body !== 'string') return [];
    const out = [];
    const re = /(^|\s)@([a-z0-9_][a-z0-9_-]{0,63})/gi;
    let m;
    while ((m = re.exec(body))) out.push(m[2].toLowerCase());
    return out;
  }

  // Handoff chain verification: chain = [b1, b2, ..., from] — the ordered
  // list of bots that have owned this thread. Every consecutive pair must be
  // backed by an actual persisted handoff message (from=a, target=b), so a
  // caller cannot fabricate a chain. All links must be distinct bot members.
  _verifyChain(room, chain, from, target) {
    if (!Array.isArray(chain)) return 'chain_must_be_array';
    if (chain.length > MAX_HANDOFF_DEPTH) return 'chain_too_deep';
    const bots = new Set(room.members.bots);
    for (const b of chain) {
      if (typeof b !== 'string' || !bots.has(b)) return 'chain_link_not_member';
    }
    if (new Set(chain).size !== chain.length) return 'chain_has_duplicates';
    if (chain.length && chain[chain.length - 1] !== from) return 'chain_must_end_at_sender';
    if (chain.includes(target)) return 'handoff_loop';
    const handoffs = room.messages.filter((m) => m.kind === 'handoff');
    for (let i = 1; i < chain.length; i++) {
      const a = chain[i - 1];
      const b = chain[i];
      if (!handoffs.some((m) => m.from === a && m.target === b)) return 'chain_not_backed_by_room_history';
    }
    return null;
  }

  // ── delivery: the governed fan-out core ────────────────────────────────

  async deliver(roomId, { from, kind = 'message', body = '', mentions = null, target = null, chain = null, replyTo = null, extra = null } = {}) {
    const room = typeof roomId === 'string' ? this.rooms.get(roomId) : roomId;
    if (!room) return { ok: false, error: 'not_found' };
    if (typeof from !== 'string' || !from.trim()) return { ok: false, error: 'from_required' };
    if (!KINDS.has(kind)) return { ok: false, error: 'bad_kind' };
    if (!room.members.bots.includes(from) && !room.members.humans.includes(from)) {
      return { ok: false, error: 'not_member' };
    }
    if (mentions !== null && mentions !== undefined && !Array.isArray(mentions)) {
      return { ok: false, error: 'mentions_must_be_array' };
    }
    if (chain !== null && chain !== undefined && !Array.isArray(chain)) {
      return { ok: false, error: 'chain_must_be_array' };
    }

    // ── caps FIRST (fail closed before anything persists or dispatches) ──
    if (room.messages.length >= room.msgCap) {
      const payload = { type: 'room_limit_hit', roomId: room.id, cap: 'msgCap', limit: room.msgCap, current: room.messages.length, from };
      this._audit(payload);
      this._broadcast(payload);
      return { ok: false, error: 'msg_cap_reached', roomId: room.id, cap: 'msgCap', limit: room.msgCap };
    }
    const isBot = room.members.bots.includes(from);
    if (isBot && this._botTurns(room) >= room.turnLimit) {
      const payload = { type: 'room_limit_hit', roomId: room.id, cap: 'turnLimit', limit: room.turnLimit, current: this._botTurns(room), from };
      this._audit(payload);
      this._broadcast(payload);
      return { ok: false, error: 'turn_limit_reached', roomId: room.id, cap: 'turnLimit', limit: room.turnLimit };
    }

    // ── kind-specific validation ─────────────────────────────────────────
    let proposal = null;
    if (kind === 'handoff') {
      if (!isBot) return { ok: false, error: 'only_bots_can_handoff' };
      if (typeof target !== 'string' || !target.trim()) return { ok: false, error: 'handoff_target_required' };
      if (!room.members.bots.includes(target)) return { ok: false, error: 'handoff_target_not_member' };
      if (target === from) return { ok: false, error: 'handoff_to_self' };
      const cErr = this._verifyChain(room, chain || [from], from, target);
      if (cErr) return { ok: false, error: cErr };
    } else if (kind === 'proposal') {
      if (!isBot) return { ok: false, error: 'only_bots_can_propose' };
      if (!this.gateway || !this.gateway.bots || !this.gateway.bots[from]) return { ok: false, error: 'unknown_bot:' + from };
      if (!body || typeof body !== 'object' || typeof body.tool !== 'string' || !body.tool) {
        return { ok: false, error: 'proposal_tool_required' };
      }
    } else {
      if (typeof body !== 'string' || !body.trim() || body.length > MAX_BODY_LEN) {
        return { ok: false, error: 'body_must_be_short_string' };
      }
    }

    // ── build the A2A envelope ───────────────────────────────────────────
    const messageId = `rm_${String(room.messages.length + 1).padStart(6, '0')}`;
    const explicitMentions = normNames(mentions || [], 'mentions');
    const parsed = kind === 'message' ? this._mentionsOf(body) : [];
    const botMembers = new Set(room.members.bots);
    const deliveredTo = [];
    for (const name of [...parsed, ...explicitMentions]) {
      if (name === from) continue;
      // CROSS-ROOM ISOLATION: only bots that are members of THIS room get a
      // fan-out hop — a mention of a bot from another room is acknowledged as
      // undeliverable but never delivered.
      if (!botMembers.has(name)) continue;
      if (!deliveredTo.includes(name)) deliveredTo.push(name);
    }
    if (kind === 'handoff' && !deliveredTo.includes(target)) deliveredTo.push(target);

    const message = {
      id: messageId,
      roomId: room.id,
      from,
      to: room.id, // A2A envelope: to:room
      kind,
      body: null,
      deliveredTo,
      ts: this.now(),
    };
    if (kind === 'proposal') {
      // Secret hygiene: the ROOM store keeps tool + argsLength only; the
      // args themselves park (at most) in the approvals store.
      message.body = { tool: body.tool, argsLength: body.args === undefined || body.args === null ? 0 : JSON.stringify(body.args).length };
    } else {
      message.body = typeof body === 'string' ? body : String(body ?? '');
    }
    if (kind === 'handoff') { message.target = target; message.chain = chain || [from]; }
    if (kind === 'assistant') {
      // A1: governed brain turn — proposal metadata only (tool + decision, no args),
      // fallback flag for deterministic-mode replies. Same secret hygiene as 'proposal'.
      if (extra && typeof extra === 'object') {
        if (extra.proposal && typeof extra.proposal === 'object') {
          message.proposal = { tool: extra.proposal.tool, decision: extra.proposal.decision ?? null };
        }
        if (extra.fallback === true) message.fallback = true;
      }
    }
    if (Array.isArray(mentions) && mentions.length) message.mentions = explicitMentions;
    if (typeof replyTo === 'string' && replyTo) message.replyTo = replyTo;

    // ── persist, then audit every hop, then SSE ──────────────────────────
    room.messages.push(message);
    this._save();

    this._audit({
      type: 'room_message', roomId: room.id, messageId, from, to: room.id, kind,
      bodyLength: message.body === null ? 0 : JSON.stringify(message.body).length,
    });
    for (const name of deliveredTo) {
      if (kind === 'handoff' && name === target) continue; // hop audited as room_handoff below
      this._audit({ type: 'room_message', roomId: room.id, messageId, from, to: name, kind: 'fanout' });
    }
    this._broadcast({ event: 'message', roomId: room.id, messageId, from, kind, deliveredTo });
    if (kind === 'handoff') {
      const hop = message.chain.concat([target]);
      this._audit({ type: 'room_handoff', roomId: room.id, messageId, from, to: target, chain: hop });
      this._broadcast({ event: 'handoff', roomId: room.id, messageId, from, to: target, chain: hop });
    }

    // ── proposals: classify/decide + approvals (governed hop) ────────────
    if (kind === 'proposal') {
      const gw = this.gateway;
      const tool = body.tool;
      const args = body.args === undefined ? null : body.args;
      const cls = classify(tool);
      const bot = { name: from, ...(gw.bots[from] || {}) };
      const verdict = decide({ tool, cls, bot });
      proposal = { tool, class: cls, decision: verdict.decision, reason: verdict.reason };
      this._audit({
        type: 'action_decision', bot: from, tool, class: cls,
        decision: verdict.decision, reason: verdict.reason,
        roomId: room.id, messageId,
        argsLength: args === null ? 0 : JSON.stringify(args).length,
      });
      if (verdict.decision === 'needs_approval') {
        const approval = gw.approvals.request({
          bot: { name: from }, tool, args, reason: `room proposal: ${verdict.reason}`,
        });
        this._audit({ type: 'approval_requested', approvalId: approval.id, bot: from, tool, class: cls, roomId: room.id, messageId });
        proposal.approvalId = approval.id;
        message.proposal = proposal;
        this._save();
      } else if (verdict.decision === 'allow' && typeof gw.dispatch === 'function') {
        try {
          const result = await gw.dispatch(from, tool, args);
          this._audit({ type: 'action_executed', bot: from, tool, ok: true, roomId: room.id, messageId });
          proposal.result = result;
        } catch (e) {
          this._audit({ type: 'action_executed', bot: from, tool, ok: false, roomId: room.id, messageId, error: String(e && e.message).slice(0, 200) });
          proposal.error = 'dispatch_failed';
        }
        message.proposal = proposal;
        this._save();
      } else {
        message.proposal = proposal;
        this._save();
      }
    }

    return { ok: true, room, message, deliveredTo, proposal };
  }
}

// ── one store per gateway (WeakMap), durable at data/rooms.json ──────────
// TG_ROOMS_FILE overrides the path (tests point it at a tmpdir).
const STORES = new WeakMap();
function defaultRoomsFile() {
  return process.env.TG_ROOMS_FILE || path.join(__dirname, '..', '..', 'data', 'rooms.json');
}
function getRoomStore(gw) {
  let s = STORES.get(gw);
  if (!s) { s = new RoomStore({ gateway: gw, file: defaultRoomsFile() }); STORES.set(gw, s); }
  return s;
}

module.exports = {
  RoomStore, getRoomStore, defaultRoomsFile,
  DEFAULT_TURN_LIMIT, DEFAULT_MSG_CAP, MAX_HANDOFF_DEPTH, KINDS,
};
