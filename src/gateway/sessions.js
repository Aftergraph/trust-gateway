'use strict';
// FS-A1 — browser sessions for human users. Storage: data/sessions.json —
// atomic tmp+rename, mode 0600, refuse-to-load-on-corrupt (fail closed).
//
// The bearer token is NEVER persisted: only sha256(token) (hex) is stored as
// the map key, so a disk leak cannot be replayed as a login. TTL is 7 days
// SLIDING — every successful use extends expiry. Max 200 live sessions per
// user; the soonest-to-expire is evicted when the cap is hit.

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const DEFAULT_FILE = path.resolve(__dirname, '..', '..', 'data', 'sessions.json');
const DEFAULT_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const MAX_PER_USER = 200;

function sha256hex(s) {
  return crypto.createHash('sha256').update(s).digest('hex');
}

class SessionStore {
  constructor({ file = DEFAULT_FILE, now = () => Date.now(), ttlMs = DEFAULT_TTL_MS, maxPerUser = MAX_PER_USER } = {}) {
    this.file = file || null;
    this.now = now;
    this.ttlMs = ttlMs;
    this.maxPerUser = maxPerUser;
    this.sessions = new Map(); // tokenHash -> { userId, createdAt, lastUsedAt, expiresAt }
    if (this.file && fs.existsSync(this.file)) this._load();
  }

  _load() {
    let doc;
    try {
      doc = JSON.parse(fs.readFileSync(this.file, 'utf8'));
    } catch {
      throw new Error('sessions: file unparseable — refusing to load (fail closed)');
    }
    if (!doc || typeof doc !== 'object' || Array.isArray(doc))
      throw new Error('sessions: file must be a JSON object keyed by token hash');
    for (const [hash, s] of Object.entries(doc)) {
      if (!/^[0-9a-f]{64}$/.test(hash) || !s || typeof s.userId !== 'string')
        throw new Error('sessions: entry malformed (fail closed)');
      this.sessions.set(hash, { userId: s.userId, createdAt: s.createdAt, lastUsedAt: s.lastUsedAt, expiresAt: s.expiresAt });
    }
  }

  _save() {
    if (!this.file) return;
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = this.file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(Object.fromEntries(this.sessions)) + '\n');
    fs.renameSync(tmp, this.file);
    try { fs.chmodSync(this.file, 0o600); } catch { /* best effort */ }
  }

  create(userId) {
    this.sweep();
    // Enforce per-user cap: evict the soonest-to-expire of that user's sessions.
    const mine = [...this.sessions.entries()]
      .filter(([, s]) => s.userId === userId)
      .sort((a, b) => a[1].expiresAt - b[1].expiresAt);
    while (mine.length >= this.maxPerUser) {
      const [oldestHash] = mine.shift();
      this.sessions.delete(oldestHash);
    }
    const token = crypto.randomBytes(32).toString('base64url'); // plaintext: returned once, never stored
    const t = this.now();
    this.sessions.set(sha256hex(token), {
      userId,
      createdAt: t,
      lastUsedAt: t,
      expiresAt: t + this.ttlMs,
    });
    this._save();
    return token;
  }

  // Sliding TTL: a valid lookup extends expiry. Returns the session or null.
  get(token) {
    if (typeof token !== 'string' || token.length === 0) return null;
    const hash = sha256hex(token);
    const s = this.sessions.get(hash);
    if (!s) return null;
    const t = this.now();
    if (t > s.expiresAt) {
      this.sessions.delete(hash);
      this._save();
      return null;
    }
    s.lastUsedAt = t;
    s.expiresAt = t + this.ttlMs;
    this._save();
    return s;
  }

  revoke(token) {
    if (typeof token !== 'string') return false;
    const hash = sha256hex(token);
    if (!this.sessions.has(hash)) return false;
    this.sessions.delete(hash);
    this._save();
    return true;
  }

  revokeAllFor(userId) {
    let n = 0;
    for (const [hash, s] of [...this.sessions.entries()]) {
      if (s.userId === userId) {
        this.sessions.delete(hash);
        n++;
      }
    }
    if (n) this._save();
    return n;
  }

  sweep() {
    const t = this.now();
    let n = 0;
    for (const [hash, s] of [...this.sessions.entries()]) {
      if (t > s.expiresAt) {
        this.sessions.delete(hash);
        n++;
      }
    }
    if (n) this._save();
    return n;
  }
}

module.exports = { SessionStore, DEFAULT_FILE, DEFAULT_TTL_MS, MAX_PER_USER };
