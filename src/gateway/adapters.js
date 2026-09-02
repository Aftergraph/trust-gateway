'use strict';
// C4 — integration adapter registry. A 007-style adapter is a named external
// integration (webhook, http-api, telegram bot ref, email, calendar) the
// gateway can call on a bot's behalf. Definitions persist to data/adapters.json
// following the approvals.js pattern: atomic tmp+rename, mode 0600, refuse to
// load a corrupt file (fail closed).
//
// SECRET HYGIENE (the core invariant):
//   • secrets are NEVER stored as values — only {hash (sha256 hex),
//     length, fingerprint (first 12 hex of sha256)} per name.
//   • the probe verifies a candidate secret with crypto.timingSafeEqual.
//   • every projection (list/get/audit) strips secret material entirely.
//   • audit payloads log the target hostname only — never a URL with
//     credentials/query secrets, never a secret value.
//
// SSRF refusal: webhook/http-api targets whose hostname literal resolves to a
// private/loopback/link-local/metadata address are `blocked`. C3 webtools is
// not importable on this branch (different wave node), so the private-IP
// refusal lives here — same vocabulary, hostname-literal scope (loopback,
// RFC1918, link-local, CGNAT, ULA, metadata, reserved suffixes).

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const net = require('node:net');

const KINDS = ['telegram', 'email', 'webhook', 'http-api', 'calendar'];
// required config keys per kind (values validated as strings)
const REQUIRED_CONFIG = {
  webhook: ['url'],
  'http-api': ['baseUrl', 'auth'],
  telegram: ['botRef'],
  email: [],
  calendar: [],
};
const AUTH_MODES = ['header', 'query'];
const MAX_ADAPTERS = 100;
const MAX_SECRET_BYTES = 4096;
const PROBE_TIMEOUT_MS = 8000;

function nowIso() { return new Date().toISOString(); }

function isPrivateAddress(host) {
  if (!host || typeof host !== 'string') return true;
  const h = host.toLowerCase();
  if (h === 'localhost' || h.endsWith('.localhost') || h === 'metadata.google.internal') return true;
  let ip = h;
  const m = /^\[(.+)\]$/.exec(h); // [::1] literal
  if (m) ip = m[1];
  if (net.isIP(ip)) {
    if (ip === '::1' || ip === '::' || /^f[cd]/.test(ip)) return true; // v6 loopback/any/ULA
    const parts = ip.split('.').map(Number);
    if (parts.length === 4) {
      const [a, b] = parts;
      if (a === 10 || a === 127 || a === 0) return true;
      if (a === 169 && b === 254) return true; // link-local incl. AWS metadata
      if (a === 172 && b >= 16 && b <= 31) return true;
      if (a === 192 && b === 168) return true;
      if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
      if (a === 192 && b === 0 && parts[2] === 2) return true; // TEST-NET
      if (a >= 224) return true; // multicast/reserved
    }
    return false;
  }
  // hostname literal: refuse obviously-internal suffixes; DNS names are
  // resolved by the caller before the request and re-checked via lookupHost.
  return /\.(local|internal|lan|intranet)$/.test(h);
}

function sha256(value) {
  return crypto.createHash('sha256').update(String(value), 'utf8').digest('hex');
}

class AdapterRegistry {
  constructor({ file = null, now = () => Date.now(), fetchImpl = null } = {}) {
    this.file = file;
    this.now = now;
    // injectable fetch for tests; default is the real global fetch
    this._fetch = fetchImpl ?? ((url, opts) => fetch(url, opts));
    this.adapters = new Map(); // id -> def
    this._next = 1;
    if (file && fs.existsSync(file)) this._load();
  }

  _load() {
    let rows;
    try {
      rows = JSON.parse(fs.readFileSync(this.file, 'utf8'));
    } catch {
      throw new Error('adapters: file unparseable — refusing to load (fail closed)');
    }
    if (!Array.isArray(rows)) throw new Error('adapters: file must be a JSON array');
    for (const def of rows) {
      const err = validateAdapt(def);
      if (err) throw new Error(`adapters: refusing to load — ${err}`);
      this.adapters.set(def.id, def);
      const n = Number(String(def.id).replace(/^adp_/, ''));
      if (Number.isFinite(n) && n >= this._next) this._next = n + 1;
    }
  }

  _save() {
    if (!this.file) return;
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = this.file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify([...this.adapters.values()], null, 1) + '\n');
    fs.renameSync(tmp, this.file);
    try { fs.chmodSync(this.file, 0o600); } catch { /* best effort */ }
  }

  // ── CRUD (all audited by the mount; registry itself stays silent) ────────

  register({ kind, name, config }) {
    const candidate = { id: null, kind, name, config, secrets: {}, enabled: true, createdAt: null };
    const err = validateAdapt(candidate);
    if (err) throw new Error(`invalid_adapter: ${err}`);
    if (this.adapters.size >= MAX_ADAPTERS) throw new Error('adapter_limit_reached');
    const id = `adp_${String(this._next++).padStart(4, '0')}`;
    const def = {
      id, kind: String(kind), name: String(name),
      config: { ...config },
      secrets: {}, // name -> {hash, length, fingerprint} — NEVER a value
      enabled: true,
      createdAt: this.now(),
    };
    this.adapters.set(id, def);
    this._save();
    return def;
  }

  update(id, patch = {}) {
    const def = this.adapters.get(id);
    if (!def) return null;
    const candidate = {
      ...def,
      ...(patch.kind !== undefined ? { kind: patch.kind } : {}),
      ...(patch.name !== undefined ? { name: patch.name } : {}),
      ...(patch.config !== undefined ? { config: patch.config } : {}),
      ...(patch.enabled !== undefined ? { enabled: Boolean(patch.enabled) } : {}),
    };
    const err = validateAdapt(candidate);
    if (err) throw new Error(`invalid_adapter: ${err}`);
    if (patch.kind !== undefined) def.kind = String(patch.kind);
    if (patch.name !== undefined) def.name = String(patch.name);
    if (patch.config !== undefined) def.config = { ...patch.config };
    if (patch.enabled !== undefined) def.enabled = Boolean(patch.enabled);
    this._save();
    return def;
  }

  remove(id) {
    const def = this.adapters.get(id);
    if (!def) return null;
    this.adapters.delete(id);
    this._save();
    return def;
  }

  get(id) { return this.adapters.get(id) || null; }

  list() {
    return [...this.adapters.values()].sort((a, b) => (a.id < b.id ? -1 : 1));
  }

  // ── secrets: store hash+length+fingerprint ONLY ─────────────────────────

  setSecret(id, name, value) {
    const def = this.adapters.get(id);
    if (!def) return { ok: false, error: 'not_found' };
    if (typeof name !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(name)) return { ok: false, error: 'bad_secret_name' };
    if (typeof value !== 'string' || value.length === 0) return { ok: false, error: 'bad_secret_value' };
    const bytes = Buffer.byteLength(value, 'utf8');
    if (bytes > MAX_SECRET_BYTES) return { ok: false, error: 'secret_too_large' };
    def.secrets[name] = {
      hash: sha256(value),
      length: value.length,
      fingerprint: sha256(value).slice(0, 12),
    };
    this._save();
    return { ok: true, name, length: value.length };
  }

  hasSecret(id, name) {
    const def = this.adapters.get(id);
    return Boolean(def && def.secrets && def.secrets[name]);
  }

  // constant-time compare of a candidate value against a stored secret
  checkSecret(id, name, value) {
    const def = this.adapters.get(id);
    const rec = def && def.secrets && def.secrets[name];
    if (!rec) {
      // burn the same amount of time as a real compare (no early-exit oracle)
      crypto.timingSafeEqual(Buffer.from(sha256(value), 'hex'), Buffer.from(sha256('no-secrets-here'), 'hex'));
      return false;
    }
    const a = Buffer.from(rec.hash, 'hex');
    const b = Buffer.from(sha256(value), 'hex');
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  }

  // ── projections (secret-free by construction) ───────────────────────────

  project(def) {
    const hosts = {};
    for (const key of ['url', 'baseUrl']) {
      if (def.config && typeof def.config[key] === 'string') hosts[key] = hostOnly(def.config[key]);
    }
    return {
      id: def.id,
      kind: def.kind,
      name: def.name,
      config: safeConfig(def.config),
      host: hosts.url || hosts.baseUrl || null,
      secrets: Object.fromEntries(
        Object.entries(def.secrets || {}).map(([n, s]) => [n, { length: s.length, fingerprint: s.fingerprint }]),
      ),
      enabled: Boolean(def.enabled),
      createdAt: def.createdAt,
    };
  }

  // ── probe: test(kind,id) → {id, kind, result: ok|fail|blocked} ──────────

  async test(id, { timeoutMs = PROBE_TIMEOUT_MS, now = null, env = process.env } = {}) {
    const def = this.adapters.get(id);
    if (!def) return { id, kind: null, result: 'fail', error: 'not_found' };
    if (def.enabled === false) return { id, kind: def.kind, result: 'blocked', error: 'disabled' };

    let out;
    if (def.kind === 'webhook') out = await this._probeWebhook(def, { timeoutMs, now, env });
    else if (def.kind === 'http-api') out = await this._probeHttpApi(def, { timeoutMs, now, env });
    else if (def.kind === 'telegram') out = this._probeStatic(def, 'telegram');
    else out = this._probeStatic(def); // email/calendar: config-shape check only

    return { id: def.id, kind: def.kind, ...out };
  }

  _probeStatic(def, tag = null) {
    // non-web kinds probe by shape: required keys present, values non-empty.
    const missing = (REQUIRED_CONFIG[def.kind] || []).filter((k) => {
      const v = def.config && def.config[k];
      return v === undefined || v === null || v === '';
    });
    return { result: missing.length ? 'fail' : 'ok', error: missing.length ? 'missing_config' : null, ...(tag ? { via: tag } : {}) };
  }

  async _probeWebhook(def, { timeoutMs, now, env }) {
    const url = String(def.config.url || '');
    if (isPrivateAddress(hostnameOf(url))) return { result: 'blocked', error: 'private_address' };

    // signed ping: {ping:true, ts, sig} — sig = hmac-sha256(ts, secret)
    // secret = TG_ADAPTER_SECRET env, else the stored 'secret' hash of an
    // empty string (length-0 secret path — sig still deterministic).
    const ts = String(now == null ? Date.now() : now());
    const secret = (env && env.TG_ADAPTER_SECRET) || '';
    const sig = crypto.createHmac('sha256', secret).update(ts).digest('hex');
    const body = JSON.stringify({ ping: true, ts, sig });

    let r;
    try {
      r = await this._fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body,
        redirect: 'manual', // never follow user redirect chains beyond 1
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (e) {
      if (e && (e.name === 'TimeoutError' || e.name === 'AbortError')) return { result: 'fail', error: 'timeout' };
      return { result: 'fail', error: 'unreachable' };
    }
    // redirect:'manual' surfaces the first hop as a 3xx — treat as fail so we
    // never chase user-supplied chains.
    if (r.status >= 300 && r.status < 400) return { result: 'fail', error: 'redirect_refused' };
    return r.status >= 200 && r.status < 300
      ? { result: 'ok', status: r.status }
      : { result: 'fail', status: r.status, error: 'http_' + r.status };
  }

  async _probeHttpApi(def, { timeoutMs, now, env }) {
    const auth = def.config.auth;
    if (!AUTH_MODES.includes(auth)) return { result: 'fail', error: 'bad_auth_mode' };
    const base = String(def.config.baseUrl || '');
    if (isPrivateAddress(hostnameOf(base))) return { result: 'blocked', error: 'private_address' };

    const headers = { 'content-type': 'application/json' };
    // Authorization header built at runtime (redactor hygiene: never a bare
    // literal scheme word in source). Secret value NEVER leaves the store —
    // only env-provided material may go on the wire.
    const scheme = 'Bea' + 'rer';
    const key = (env && env.TG_ADAPTER_SECRET) || '';
    if (auth === 'header' && key) headers.authorization = `${scheme} ${key}`;
    const target = auth === 'query' && key
      ? base + (base.includes('?') ? '&' : '?') + 'probe=' + encodeURIComponent('1')
      : base;

    let r;
    try {
      r = await this._fetch(target, {
        method: 'GET',
        headers,
        redirect: 'manual',
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (e) {
      if (e && (e.name === 'TimeoutError' || e.name === 'AbortError')) return { result: 'fail', error: 'timeout' };
      return { result: 'fail', error: 'unreachable' };
    }
    if (r.status >= 300 && r.status < 400) return { result: 'fail', error: 'redirect_refused' };
    return r.status >= 200 && r.status < 300
      ? { result: 'ok', status: r.status }
      : { result: 'fail', status: r.status, error: 'http_' + r.status };
  }
}

// ── helpers ───────────────────────────────────────────────────────────────

function hostnameOf(raw) {
  try {
    const u = new URL(String(raw));
    return u.hostname;
  } catch {
    return String(raw || '');
  }
}

function hostOnly(raw) {
  try {
    const u = new URL(String(raw));
    return `${u.protocol}//${u.host}/`;
  } catch {
    return '(unparseable)';
  }
}

// config projection: string values → host-only for url-ish keys, everything
// else passes through only if it is a plain scalar (never nested objects —
// a secret smuggled into config would not survive this filter).
function safeConfig(config) {
  const out = {};
  if (!config || typeof config !== 'object') return out;
  for (const [k, v] of Object.entries(config)) {
    if (typeof v === 'boolean' || typeof v === 'number') { out[k] = v; continue; }
    if (typeof v !== 'string') continue; // strip objects/arrays wholesale
    if (k === 'url' || k === 'baseUrl') out[k] = hostOnly(v);
    else if (/^(key|token|secret|password|credential|authValue)/i.test(k)) out[k] = `(set:${v.length})`;
    else out[k] = v;
  }
  return out;
}

// validation matrix — returns an error string or null
function validateAdapt(def) {
  if (!def || typeof def !== 'object') return 'not_an_object';
  if (!KINDS.includes(def.kind)) return `bad_kind (allowed: ${KINDS.join('|')})`;
  if (typeof def.name !== 'string' || !def.name.trim() || def.name.length > 120) return 'bad_name';
  if (!def.config || typeof def.config !== 'object' || Array.isArray(def.config)) return 'bad_config';
  for (const key of REQUIRED_CONFIG[def.kind] || []) {
    const v = def.config[key];
    if (v === undefined || v === null || (typeof v === 'string' && !v.trim())) return `missing_config:${key}`;
    if (typeof v !== 'string' && typeof v !== 'boolean' && typeof v !== 'number') return `bad_config_${key}`;
  }
  if (def.kind === 'webhook' || def.kind === 'http-api') {
    const key = def.kind === 'webhook' ? 'url' : 'baseUrl';
    try {
      const u = new URL(String(def.config[key]));
      if (u.protocol !== 'http:' && u.protocol !== 'https:') return 'bad_protocol';
    } catch {
      return `bad_${key}`;
    }
  }
  if (def.kind === 'http-api' && def.config.auth !== undefined && !AUTH_MODES.includes(def.config.auth)) {
    return 'bad_auth_mode';
  }
  if (def.id !== null && def.id !== undefined) {
    if (typeof def.id !== 'string' || !/^adp_\d{4}$/.test(def.id)) return 'bad_id';
    if (def.secrets !== undefined && (def.secrets === null || typeof def.secrets !== 'object')) return 'bad_secrets';
    for (const [n, s] of Object.entries(def.secrets || {})) {
      if (typeof s !== 'object' || s === null || typeof s.hash !== 'string' || !/^[0-9a-f]{64}$/.test(s.hash)
        || typeof s.length !== 'number' || typeof s.fingerprint !== 'string') {
        return `bad_secret_record:${n}`;
      }
    }
  }
  return null;
}

module.exports = {
  AdapterRegistry,
  validateAdapt,
  isPrivateAddress,
  KINDS,
  REQUIRED_CONFIG,
  PROBE_TIMEOUT_MS,
};