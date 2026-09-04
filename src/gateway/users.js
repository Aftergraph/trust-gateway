'use strict';
// FS-A1 — human user accounts (the layer ABOVE bots; bots stay the agent
// identities). Storage: data/users.json — atomic tmp+rename, mode 0600,
// refuse-to-load-on-corrupt (fail closed). Same pattern as approvals.js.
//
// File shape: JSON array of
//   { id:'u_<8hex>', email (unique, lowercase), passwordHash (scrypt hex),
//     salt (hex), role:'owner'|'operator'|'member', display_name,
//     created_at (ISO), disabled:boolean }
//
// NEVER store plaintext passwords. NEVER return passwordHash/salt from
// project() — HTTP surfaces use the projection only.

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const DEFAULT_FILE = path.resolve(__dirname, '..', '..', 'data', 'users.json');
const ROLES = ['owner', 'operator', 'member'];
const KEYLEN = 64; // scrypt output bytes
const MIN_PASSWORD_LEN = 10;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function newId() {
  return 'u_' + crypto.randomBytes(4).toString('hex');
}

function hashPassword(password, salt) {
  return crypto.scryptSync(String(password), salt, KEYLEN).toString('hex');
}

class UserStore {
  constructor({ file = DEFAULT_FILE, now = () => Date.now(), firstUserRole = process.env.TG_FIRST_USER_ROLE } = {}) {
    this.file = file || null;
    this.now = now;
    this.firstUserRole = ROLES.includes(firstUserRole) ? firstUserRole : 'owner';
    this.users = new Map();    // id -> user
    this._byEmail = new Map(); // lowercase email -> id
    if (this.file && fs.existsSync(this.file)) this._load();
  }

  _load() {
    let arr;
    try {
      arr = JSON.parse(fs.readFileSync(this.file, 'utf8'));
    } catch {
      throw new Error('users: file unparseable — refusing to load (fail closed)');
    }
    if (!Array.isArray(arr)) throw new Error('users: file must be a JSON array');
    for (const u of arr) {
      if (!u || typeof u.id !== 'string' || typeof u.email !== 'string' || typeof u.passwordHash !== 'string')
        throw new Error('users: entry missing id/email/passwordHash');
      if (this._byEmail.has(u.email)) throw new Error('users: duplicate email on load (fail closed)');
      this.users.set(u.id, u);
      this._byEmail.set(u.email, u.id);
    }
  }

  _save() {
    if (!this.file) return;
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = this.file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify([...this.users.values()]) + '\n', { mode: 0o600 });
    fs.renameSync(tmp, this.file);
    try { fs.chmodSync(this.file, 0o600); } catch { /* best effort */ }
  }

  project(u) {
    // Hand-picked allow-list so a sensitive field added later cannot leak.
    if (!u) return null;
    return {
      id: u.id,
      email: u.email,
      role: u.role,
      display_name: u.display_name ?? null,
      created_at: u.created_at,
      disabled: !!u.disabled,
    };
  }

  create({ email, password, display_name = null } = {}) {
    if (typeof email !== 'string' || !EMAIL_RE.test(email.trim()))
      return { ok: false, error: 'invalid_email' };
    if (typeof password !== 'string' || password.length < MIN_PASSWORD_LEN)
      return { ok: false, error: 'weak_password' };
    const norm = email.trim().toLowerCase();
    if (this._byEmail.has(norm)) return { ok: false, error: 'email_taken' };
    // First registered user owns the instance; everyone after is a member.
    const role = this.users.size === 0 ? this.firstUserRole : 'member';
    const salt = crypto.randomBytes(16).toString('hex');
    const user = {
      id: newId(),
      email: norm,
      passwordHash: hashPassword(password, salt),
      salt,
      role,
      display_name: display_name == null ? null : String(display_name).slice(0, 120),
      created_at: new Date(this.now()).toISOString(),
      disabled: false,
    };
    this.users.set(user.id, user);
    this._byEmail.set(norm, user.id);
    this._save();
    return { ok: true, user: this.project(user) };
  }

  list() {
    return [...this.users.values()].map((u) => this.project(u));
  }

  getByEmail(email) {
    if (typeof email !== 'string') return null;
    const id = this._byEmail.get(email.trim().toLowerCase());
    return id ? this.users.get(id) : null;
  }

  getById(id) {
    return this.users.get(id) || null;
  }

  // Constant-time verification via timingSafeEqual. Returns false (never
  // throws) on missing user / bad input so callers can emit one generic error.
  verifyPassword(user, password) {
    if (!user || typeof user.passwordHash !== 'string' || typeof user.salt !== 'string' || typeof password !== 'string')
      return false;
    const stored = Buffer.from(user.passwordHash, 'hex');
    const cand = crypto.scryptSync(password, user.salt, KEYLEN);
    return stored.length === cand.length && crypto.timingSafeEqual(stored, cand);
  }

  setPassword(id, password) {
    const u = this.users.get(id);
    if (!u) return { ok: false, error: 'not_found' };
    if (typeof password !== 'string' || password.length < MIN_PASSWORD_LEN)
      return { ok: false, error: 'weak_password' };
    u.salt = crypto.randomBytes(16).toString('hex');
    u.passwordHash = hashPassword(password, u.salt);
    this._save();
    return { ok: true };
  }

  setRole(id, role) {
    const u = this.users.get(id);
    if (!u) return { ok: false, error: 'not_found' };
    if (!ROLES.includes(role)) return { ok: false, error: 'bad_role' };
    u.role = role;
    this._save();
    return { ok: true };
  }

  setDisabled(id, disabled) {
    const u = this.users.get(id);
    if (!u) return { ok: false, error: 'not_found' };
    u.disabled = !!disabled;
    this._save();
    return { ok: true };
  }
}

// Dummy verification for unknown emails: burns the same scrypt cost as a real
// check so response timing cannot distinguish "no such user" from "wrong
// password" (anti-enumeration).
const DUMMY_SALT = crypto.createHash('sha256').update('tg-dummy-salt').digest('hex').slice(0, 32);
const DUMMY_HASH = hashPassword('dummy-password-for-timing', DUMMY_SALT);
function timingBurn(password) {
  const stored = Buffer.from(DUMMY_HASH, 'hex');
  const cand = crypto.scryptSync(String(password ?? ''), DUMMY_SALT, KEYLEN);
  crypto.timingSafeEqual(stored, cand);
}

module.exports = { UserStore, project: UserStore.prototype.project, timingBurn, ROLES, MIN_PASSWORD_LEN, DEFAULT_FILE };
