'use strict';
// v2 wave F3 — per-agent memory store.
//
// Persistent, inspectable fact objects owned by individual bots.
// Storage: data/memory.json — atomic tmp+rename, mode 0600,
// refuse-to-load-on-corrupt (fail closed). Same pattern as
// src/gateway/approvals.js.
//
// data/memory.json shape (spec):
//   {<botName>: {facts: [{id:'m_<8hex>', text, source, sourceChainSeq?,
//     createdAt, lastUsedAt, decayAt? (ISO), tags: string[], pin: boolean}],
//     updatedAt}}
//
// Decay rule (spec): facts whose decayAt is in the past are filtered from
// default reads UNLESS pinned. Pinned facts ignore decay. Expired facts are
// NEVER auto-deleted — silent data mutation is forbidden (spec rule).

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const DEFAULT_FILE = path.resolve(__dirname, '..', '..', 'data', 'memory.json');
const MAX_TEXT_LEN = 4000;

function err(code, message) {
  const e = new Error(message);
  e.code = code;
  return e;
}

class MemoryStore {
  constructor({ file = null, now = () => Date.now() } = {}) {
    this.file = file;
    this.now = now;
    this.bots = {}; // botName -> { facts: [...], updatedAt }
    if (file && fs.existsSync(file)) this._load();
  }

  _load() {
    let doc;
    try {
      doc = JSON.parse(fs.readFileSync(this.file, 'utf8'));
    } catch {
      throw new Error('memory: file unparseable — refusing to load (fail closed)');
    }
    if (!doc || typeof doc !== 'object')
      throw new Error('memory: file must be a JSON object keyed by bot name');
    for (const [botName, botData] of Object.entries(doc)) {
      if (!Array.isArray(botData.facts))
        throw new Error('memory: ' + botName + ' must have facts array');
      for (const f of botData.facts) {
        if (!f || typeof f.id !== 'string')
          throw new Error('memory: fact entry missing id in ' + botName);
        if (typeof f.text !== 'string')
          throw new Error('memory: fact ' + f.id + ' in ' + botName + ' must have text string');
      }
      this.bots[botName] = { facts: [...botData.facts], updatedAt: botData.updatedAt || this.now() };
    }
  }

  _save() {
    if (!this.file) return;
    const doc = {};
    for (const botName of Object.keys(this.bots).sort()) {
      doc[botName] = {
        facts: this.bots[botName].facts,
        updatedAt: this.bots[botName].updatedAt || this.now(),
      };
    }
    const dir = path.dirname(this.file);
    fs.mkdirSync(dir, { recursive: true });
    const tmp = this.file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(doc) + '\n');
    fs.renameSync(tmp, this.file);
    try { fs.chmodSync(this.file, 0o600); } catch { /* best effort */ }
  }

  // ── list facts for a bot (default: non-expired only) ──

  list(botName, { includeExpired = false } = {}) {
    const bot = this.bots[botName];
    if (!bot) return [];
    const now = this.now();
    return bot.facts.filter((f) => {
      if (f.pin) return true; // pinned facts ignore decay
      if (includeExpired) return true;
      if (f.decayAt) {
        const decayMs = new Date(f.decayAt).getTime();
        if (!isNaN(decayMs) && decayMs < now) return false;
      }
      return true;
    });
  }

  // ── get a single fact by id, scoped to bot ──

  get(botName, id) {
    const bot = this.bots[botName];
    if (!bot) return null;
    const fact = bot.facts.find((f) => f.id === id);
    return fact || null;
  }

  // ── create a fact ──

  create({ bot, text, source = 'user', tags = [], pin = false, decayAt = null, sourceChainSeq = null }) {
    if (!bot || typeof bot !== 'string') throw err('bad_request', 'bot name required');
    if (typeof text !== 'string' || text.length === 0) throw err('bad_request', 'text required');
    if (text.length > MAX_TEXT_LEN) throw err('bad_request', 'text too long (max 4000)');
    if (!this.bots[bot]) this.bots[bot] = { facts: [], updatedAt: this.now() };
    const validSources = ['user', 'agent-self', 'tool-result', 'imported'];
    if (!validSources.includes(source)) throw err('bad_request', 'invalid source');
    const now = this.now();
    const fact = {
      id: 'm_' + crypto.randomBytes(4).toString('hex'),
      bot, // durable owner stamp — mounts scope access by it (FS-D2 fix: the
           // shape must be self-describing; edit/remove return it too)
      text,
      source,
      tags: Array.isArray(tags) ? tags : [],
      pin: !!pin,
      decayAt: decayAt || null,
      sourceChainSeq: sourceChainSeq || null,
      createdAt: now,
      lastUsedAt: now,
    };
    this.bots[bot].facts.push(fact);
    this.bots[bot].updatedAt = now;
    this._save();
    return fact;
  }

  // ── edit a fact ──

  edit(id, { text, tags, pin, decayAt } = {}) {
    for (const botName of Object.keys(this.bots)) {
      const idx = this.bots[botName].facts.findIndex((f) => f.id === id);
      if (idx === -1) continue;
      const fact = this.bots[botName].facts[idx];
      fact.bot = botName; // backfill for pre-stamp records (idempotent)
      if (typeof text === 'string') {
        if (text.length === 0) throw err('bad_request', 'text cannot be empty');
        if (text.length > MAX_TEXT_LEN) throw err('bad_request', 'text too long (max 4000)');
        fact.text = text;
      }
      if (tags !== undefined) fact.tags = Array.isArray(tags) ? tags : [];
      if (pin !== undefined) fact.pin = !!pin;
      if (decayAt !== undefined) fact.decayAt = decayAt || null;
      fact.lastUsedAt = this.now();
      this.bots[botName].updatedAt = this.now();
      this._save();
      return fact;
    }
    throw err('not_found', 'memory fact not found');
  }

  // ── remove a fact ──

  remove(id) {
    for (const botName of Object.keys(this.bots)) {
      const idx = this.bots[botName].facts.findIndex((f) => f.id === id);
      if (idx === -1) continue;
      const removed = this.bots[botName].facts.splice(idx, 1);
      removed[0].bot = removed[0].bot || botName; // backfill pre-stamp records
      if (this.bots[botName].facts.length === 0) {
        delete this.bots[botName];
      } else {
        this.bots[botName].updatedAt = this.now();
      }
      this._save();
      return removed[0];
    }
    throw err('not_found', 'memory fact not found');
  }
}

// Single MemoryStore instance per gateway, like artifacts pattern.
const _instances = new WeakMap();
function getMemoryStore(gw) {
  let s = _instances.get(gw);
  if (!s) {
    s = new MemoryStore({ file: DEFAULT_FILE });
    _instances.set(gw, s);
  }
  return s;
}

module.exports = { MemoryStore, DEFAULT_FILE, getMemoryStore };
