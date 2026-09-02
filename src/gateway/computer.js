'use strict';
// Trust Gateway v2 — Live Computer sessions (W5).
//
// A ComputerSession is a governed view of a bot working at a keyboard:
//   { id, bot, label, state: idle|running|awaiting-human|done,
//     frames: [{ index, ts, kind: action|output|refusal|secret-request,
//                summary, ref, prevHash, entryHash }], ... }
//
// Frames are hash-chained (each entryHash covers the frame plus the previous
// frame's hash), so tampering with any retained frame is detectable. The frame
// list is CAPPED: when the cap is exceeded, the oldest frames are dropped and
// the session records `anchor` = the last dropped entryHash, so verification
// of the retained window always has a starting point.
//
// Frames carry SUMMARIES ONLY — the store refuses any payload that tries to
// smuggle raw args (args/argv/input/values keys). Secrets never hit disk.
//
// Persistence mirrors approvals.js: own JSON file under data/, atomic
// tmp+rename, mode 0600, refuse-to-load-on-corrupt (fail closed).
//
// Human control: takeover parks the session in 'awaiting-human' (the bot must
// stop), release hands it back to 'running'. Both are stateful decisions — the
// mount audits control_taken / control_released; refused control attempts are
// audited too (returned here as { ok:false, error } for the mount to record).

const fs = require('node:fs');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { canonical, sha256 } = require('./hash-chain');

const KINDS = Object.freeze(['action', 'output', 'refusal', 'secret-request']);
const STATES = Object.freeze(['idle', 'running', 'awaiting-human', 'done']);
const GENESIS_HASH = '0'.repeat(64);
const MAX_FRAMES = 200;       // retained window per session
const MAX_SUMMARY = 500;
const MAX_LABEL = 120;
const RAW_ARG_KEYS = ['args', 'argv', 'input', 'values', 'params', 'secret'];

// State machine: done is terminal; takeover/release drive awaiting-human.
const TRANSITIONS = Object.freeze({
  idle: ['running', 'awaiting-human', 'done'],
  running: ['idle', 'awaiting-human', 'done'],
  'awaiting-human': ['running', 'idle', 'done'],
  done: [],
});

function frameHash(sessionId, index, prevHash, ts, kind, summary, ref) {
  return sha256(`cs|${sessionId}|${index}|${prevHash}|${ts}|${canonical({ kind, summary, ref })}`);
}

class ComputerStore extends EventEmitter {
  constructor({
    file = null,
    now = () => Date.now(),
    maxFrames = MAX_FRAMES,
  } = {}) {
    super();
    this.file = file;
    this.now = now;
    this.maxFrames = maxFrames;
    this.sessions = new Map(); // id -> session
    this._next = 1;
    if (file && fs.existsSync(file)) this._load();
  }

  // ── persistence (fail closed) ──────────────────────────────────
  _load() {
    let arr;
    try {
      arr = JSON.parse(fs.readFileSync(this.file, 'utf8'));
    } catch {
      throw new Error('computer: file unparseable — refusing to load (fail closed)');
    }
    if (!Array.isArray(arr)) throw new Error('computer: file must be a JSON array');
    for (const s of arr) {
      if (!s || typeof s.id !== 'string') throw new Error('computer: entry missing id');
      if (!STATES.includes(s.state)) throw new Error(`computer: entry ${s.id} has unknown state`);
      if (!Array.isArray(s.frames)) throw new Error(`computer: entry ${s.id} frames missing`);
      const v = this.verifyChain(s);
      if (!v.ok) throw new Error(`computer: entry ${s.id} frame chain invalid at index ${v.at} (${v.reason}) — refusing to load`);
      this.sessions.set(s.id, s);
      const n = Number(s.id.replace(/^cs_/, ''));
      if (Number.isFinite(n) && n >= this._next) this._next = n + 1;
    }
  }

  _save() {
    if (!this.file) return;
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = this.file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify([...this.sessions.values()]) + '\n');
    fs.renameSync(tmp, this.file);
    try { fs.chmodSync(this.file, 0o600); } catch { /* best effort */ }
  }

  // ── sessions ───────────────────────────────────────────────────
  create({ bot = null, label = null } = {}) {
    if (label !== null && (typeof label !== 'string' || label.length < 1 || label.length > MAX_LABEL))
      return { ok: false, error: 'bad_label' };
    const id = `cs_${String(this._next++).padStart(6, '0')}`;
    const ts = this.now();
    const s = {
      id,
      bot: bot ?? null,
      label: label ?? null,
      state: 'idle',
      frames: [],
      frameCount: 0,   // total ever appended (monotonic index)
      anchor: null,    // last dropped entryHash once the cap trims
      control: null,   // { heldBy, since } while a human holds control
      createdAt: ts,
      updatedAt: ts,
    };
    this.sessions.set(id, s);
    this._save();
    return { ok: true, session: s };
  }

  get(id) {
    return this.sessions.get(id) ?? null;
  }

  list({ bot = null, state = null } = {}) {
    let out = [...this.sessions.values()];
    if (bot) out = out.filter((s) => s.bot === bot);
    if (state) out = out.filter((s) => s.state === state);
    return out;
  }

  // ── frames (chained, capped, summaries only) ───────────────────
  // Refuses raw args: any frame object carrying one of RAW_ARG_KEYS is a
  // hard rejection ({ error: 'raw_args_forbidden' }) — the mount audits it.
  appendFrame(id, frame = {}) {
    const s = this.sessions.get(id);
    if (!s) return { ok: false, error: 'not_found' };
    if (s.state === 'done') return { ok: false, error: 'session_done' };
    for (const k of RAW_ARG_KEYS) {
      if (frame[k] !== undefined) return { ok: false, error: 'raw_args_forbidden' };
    }
    const { kind, summary } = frame;
    const ref = frame.ref ?? null;
    if (!KINDS.includes(kind)) return { ok: false, error: 'bad_kind' };
    if (typeof summary !== 'string' || summary.length < 1 || summary.length > MAX_SUMMARY)
      return { ok: false, error: 'bad_summary' };
    if (ref !== null && typeof ref !== 'string') return { ok: false, error: 'bad_ref' };

    const index = s.frameCount;
    const prevHash = s.frames.length > 0 ? s.frames[s.frames.length - 1].entryHash
      : (s.anchor ?? GENESIS_HASH);
    const ts = this.now();
    const f = {
      index, ts, kind, summary, ref: ref ?? null, prevHash,
      entryHash: frameHash(s.id, index, prevHash, ts, kind, summary, ref ?? null),
    };
    s.frames.push(f);
    s.frameCount += 1;
    s.updatedAt = ts;
    // Cap the retained window; anchor moves so verification keeps working.
    while (s.frames.length > this.maxFrames) {
      const dropped = s.frames.shift();
      s.anchor = dropped.entryHash;
    }
    this._save();
    this.emit('frame', { session: s, frame: f });
    return { ok: true, session: s, frame: f };
  }

  // Verify the retained window: recomputes every entryHash and checks each
  // prevHash link (first retained frame anchors to the last dropped frame or
  // to the chain genesis).
  verifyChain(s) {
    let expectPrev = s.anchor ?? GENESIS_HASH;
    for (let i = 0; i < s.frames.length; i++) {
      const f = s.frames[i];
      if (f.prevHash !== expectPrev) return { ok: false, at: f.index, reason: 'prev_hash_mismatch' };
      const expected = frameHash(s.id, f.index, f.prevHash, f.ts, f.kind, f.summary, f.ref ?? null);
      if (f.entryHash !== expected) return { ok: false, at: f.index, reason: 'hash_mismatch' };
      expectPrev = f.entryHash;
    }
    return { ok: true, length: s.frames.length, head: expectPrev };
  }

  // ── state + human control ──────────────────────────────────────
  setState(id, next) {
    const s = this.sessions.get(id);
    if (!s) return { ok: false, error: 'not_found' };
    if (!STATES.includes(next)) return { ok: false, error: 'bad_state' };
    if (next === s.state) return { ok: true, session: s, unchanged: true };
    if (!TRANSITIONS[s.state].includes(next))
      return { ok: false, error: 'bad_transition', from: s.state, to: next };
    const from = s.state;
    s.state = next;
    s.updatedAt = this.now();
    if (next !== 'awaiting-human') s.control = null;
    this._save();
    this.emit('state', { session: s, from, to: next });
    return { ok: true, session: s, from, to: next };
  }

  // Human takeover: park the session for the human. Refused if the session is
  // already done or already held (the mount audits every refusal).
  takeover(id, by) {
    const s = this.sessions.get(id);
    if (!s) return { ok: false, error: 'not_found' };
    if (s.state === 'done') return { ok: false, error: 'session_done' };
    if (s.state === 'awaiting-human')
      return { ok: false, error: 'already_held', heldBy: s.control ? s.control.heldBy : null };
    const from = s.state;
    const ts = this.now();
    s.state = 'awaiting-human';
    s.control = { heldBy: by, since: ts };
    s.updatedAt = ts;
    this._save();
    this.emit('state', { session: s, from, to: 'awaiting-human' });
    return { ok: true, session: s, from, to: 'awaiting-human' };
  }

  release(id, by) {
    const s = this.sessions.get(id);
    if (!s) return { ok: false, error: 'not_found' };
    if (s.state !== 'awaiting-human') return { ok: false, error: 'not_held' };
    if (s.control && s.control.heldBy && s.control.heldBy !== by)
      return { ok: false, error: 'held_by_other', heldBy: s.control.heldBy };
    const from = s.state;
    s.state = 'running';
    s.control = null;
    s.updatedAt = this.now();
    this._save();
    this.emit('state', { session: s, from, to: 'running' });
    return { ok: true, session: s, from, to: 'running' };
  }
}

// One durable store per gateway instance (WeakMap, mirrors chat-singleton.js).
// File location: TG_COMPUTER_FILE env override, else <repo>/data/computer.json.
const computerStores = new WeakMap();
function getComputerStore(gw) {
  let st = computerStores.get(gw);
  if (!st) {
    const file = process.env.TG_COMPUTER_FILE
      || path.join(__dirname, '..', '..', 'data', 'computer.json');
    st = new ComputerStore({ file, now: () => (gw && gw.now ? gw.now() : Date.now()) });
    computerStores.set(gw, st);
  }
  return st;
}

module.exports = {
  ComputerStore, KINDS, STATES, MAX_FRAMES, MAX_SUMMARY,
  GENESIS_HASH, RAW_ARG_KEYS, TRANSITIONS, frameHash, getComputerStore,
};
