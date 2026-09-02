'use strict';
// Trust Gateway v2 — W4 plugin / MCP / skills hub (PLATFORM-ABI.md row W4).
//
// Modules (plugins) live as SOURCES under modules/<id>/ with a plugin.json
// manifest. Installing copies the directory into data/modules/<id>/ (the
// running copy), exactly like the approvals store: persistent state lives in
// ONE JSON file under data/, atomic tmp+rename, mode 0600, and a corrupt
// state file REFUSES to load (fail closed).
//
// Secrets are write-only over the API: setSecret stores the value and echoes
// back only {name, configured, length}. Values never appear in any response
// projection or audit payload (length only).
//
// Skills are markdown docs with frontmatter (name/description/trigger,
// trigger capped at 57 chars — the platform skill convention).
//
// MCP servers are registry-level in wave A: validate stdio (command) vs
// http/sse (url), reject malformed defs. No live stdio client until wave B.

const fs = require('node:fs');
const path = require('node:path');

const SLUG_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const SECRET_NAME_RE = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;
const SEMVER_RE = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/;
const TRIGGER_MAX = 57;
const NAME_MAX = 64;
const DESC_MAX = 200;
const SECRET_VALUE_MAX = 8192;
const MANIFEST_MAX = 64 * 1024;
const SKILL_FILE_MAX = 64 * 1024;
const STATE_VERSION = 1;

const DEFAULT_SOURCE_DIR = path.join(__dirname, '..', '..', 'modules');
const DEFAULT_DATA_DIR = path.join(__dirname, '..', '..', 'data');

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

// ── manifest validation ───────────────────────────────────────────

function validateManifest(raw, { dirName } = {}) {
  const errors = [];
  if (!isPlainObject(raw)) {
    return { ok: false, errors: ['manifest must be a JSON object'] };
  }
  const allowed = new Set(['id', 'name', 'version', 'entry', 'description', 'capabilities', 'secrets', 'mcp']);
  for (const k of Object.keys(raw)) {
    if (!allowed.has(k)) errors.push(`unknown_field:${k}`);
  }

  const { id, name, version, entry } = raw;
  if (typeof id !== 'string' || !SLUG_RE.test(id)) errors.push('id must be a lowercase slug [a-z0-9][a-z0-9._-]*');
  if (typeof dirName === 'string' && typeof id === 'string' && id !== dirName) {
    errors.push(`id_mismatch:manifest=${id} dir=${dirName}`);
  }
  if (typeof name !== 'string' || name.trim() === '' || name.length > NAME_MAX) {
    errors.push(`name required, 1-${NAME_MAX} chars`);
  }
  if (typeof version !== 'string' || !SEMVER_RE.test(version)) errors.push('version must be x.y.z semver');
  if (typeof entry !== 'string' || entry === '' || entry.includes('..') || entry.includes('\0')
      || path.isAbsolute(entry) || !entry.endsWith('.js')) {
    errors.push('entry must be a relative .js path without ..');
  }
  if (raw.description !== undefined && (typeof raw.description !== 'string' || raw.description.length > DESC_MAX)) {
    errors.push(`description must be a string ≤${DESC_MAX} chars`);
  }

  let capabilities = [];
  if (raw.capabilities !== undefined) {
    if (!Array.isArray(raw.capabilities) || raw.capabilities.some((c) => typeof c !== 'string' || c === '')) {
      errors.push('capabilities must be an array of non-empty strings');
    } else {
      capabilities = raw.capabilities.slice();
    }
  }

  let secrets = [];
  if (raw.secrets !== undefined) {
    if (!Array.isArray(raw.secrets) || raw.secrets.some((s) => !isPlainObject(s)
        || typeof s.name !== 'string' || !SECRET_NAME_RE.test(s.name)
        || (s.required !== undefined && typeof s.required !== 'boolean'))) {
      errors.push('secrets must be an array of {name, required?} with valid names');
    } else {
      const seen = new Set();
      for (const s of raw.secrets) {
        if (seen.has(s.name)) { errors.push(`secret_duplicate:${s.name}`); continue; }
        seen.add(s.name);
        secrets.push({ name: s.name, required: s.required === true });
      }
    }
  }

  let mcp = [];
  if (raw.mcp !== undefined) {
    if (!Array.isArray(raw.mcp)) {
      errors.push('mcp must be an array of server definitions');
    } else {
      for (const def of raw.mcp) {
        const v = validateMcpDef(def);
        if (!v.ok) errors.push(...v.errors.map((e) => `mcp: ${e}`));
        else mcp.push(v.def);
      }
    }
  }

  if (errors.length) return { ok: false, errors };
  return {
    ok: true,
    manifest: {
      id,
      name: name.trim(),
      version,
      entry,
      description: raw.description || '',
      capabilities,
      secrets,
      mcp,
    },
  };
}

// ── skill frontmatter parser ──────────────────────────────────────
// Accepts:
//   ---
//   name: some-slug
//   description: what it does
//   trigger: Use when <something>. <≤57 chars>
//   ---
//   body ...
function parseSkillFrontmatter(text) {
  if (typeof text !== 'string') return { ok: false, errors: ['skill must be a string'] };
  const m = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(\r?\n[\s\S]*|\r?\n?$)/.exec(text);
  if (!m) return { ok: false, errors: ['no_frontmatter: file must start with --- key: value ---'] };
  const [, fmBlock, bodyRaw = ''] = m;
  const errors = [];
  const fields = {};
  for (const line of fmBlock.split(/\r?\n/)) {
    if (line.trim() === '' || /^\s*#/.test(line)) continue;
    const kv = /^([A-Za-z_][A-Za-z0-9_-]*)[ \t]*:[ \t]*(.*)$/.exec(line);
    if (!kv) { errors.push(`bad_frontmatter_line:${line.slice(0, 40)}`); continue; }
    const key = kv[1].toLowerCase();
    if (!['name', 'description', 'trigger'].includes(key)) { errors.push(`unknown_field:${key}`); continue; }
    if (fields[key] !== undefined) { errors.push(`duplicate_field:${key}`); continue; }
    fields[key] = kv[2].trim().replace(/^(['"])(.*)\1$/, '$2');
  }

  const { name, description, trigger } = fields;
  if (typeof name !== 'string' || !SLUG_RE.test(name || '')) errors.push('name must be a lowercase slug');
  if (typeof description !== 'string' || description === '' || description.length > DESC_MAX) {
    errors.push(`description required, ≤${DESC_MAX} chars`);
  }
  if (typeof trigger !== 'string' || trigger === '') errors.push('trigger required');
  else if (trigger.length > TRIGGER_MAX) errors.push(`trigger_too_long:${trigger.length}>${TRIGGER_MAX}`);
  if (!/^\s*\S/.test(bodyRaw)) errors.push('empty_body: skill needs a procedure after the frontmatter');

  if (errors.length) return { ok: false, errors };
  return { ok: true, skill: { name, description, trigger, body: bodyRaw.trim() } };
}

// ── MCP registry validation ───────────────────────────────────────
const MCP_TRANSPORTS = new Set(['stdio', 'http', 'sse']);
const MCP_ALLOWED_KEYS = new Set(['name', 'transport', 'command', 'args', 'url', 'env', 'description']);

function validateMcpDef(def) {
  if (!isPlainObject(def)) return { ok: false, errors: ['mcp server must be an object'] };
  const errors = [];
  for (const k of Object.keys(def)) {
    if (!MCP_ALLOWED_KEYS.has(k)) errors.push(`unknown_field:${k}`);
  }
  const { name, transport, command, args, url, env } = def;
  if (typeof name !== 'string' || !SLUG_RE.test(name)) errors.push('name must be a lowercase slug');
  if (typeof transport !== 'string' || !MCP_TRANSPORTS.has(transport)) {
    errors.push('transport must be stdio|http|sse');
  } else if (transport === 'stdio') {
    if (typeof command !== 'string' || command.trim() === '') errors.push('stdio requires a non-empty command');
    if (url !== undefined) errors.push('stdio must not carry url');
    if (args !== undefined && (!Array.isArray(args) || args.some((a) => typeof a !== 'string'))) {
      errors.push('args must be an array of strings');
    }
  } else {
    if (typeof url !== 'string' || !isHttpUrl(url)) errors.push(`${transport} requires a valid http(s) url`);
    if (command !== undefined) errors.push(`${transport} must not carry command`);
    if (args !== undefined) errors.push(`${transport} must not carry args`);
  }
  if (env !== undefined) {
    if (!isPlainObject(env) || Object.values(env).some((v) => typeof v !== 'string')) {
      errors.push('env must be an object of string values');
    }
  }
  if (def.description !== undefined && typeof def.description !== 'string') errors.push('description must be a string');
  if (errors.length) return { ok: false, errors };
  const clean = { name, transport };
  if (command !== undefined) clean.command = command;
  if (args !== undefined) clean.args = args.slice();
  if (url !== undefined) clean.url = url;
  if (env !== undefined) clean.envKeys = Object.keys(env).sort(); // values stay in state, never in views
  return { ok: true, def: clean, env: env ? { ...env } : undefined };
}

function isHttpUrl(s) {
  try {
    const u = new URL(s);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}

// ── PluginHub ─────────────────────────────────────────────────────

class PluginHub {
  constructor({
    dataDir = process.env.TG_PLUGINS_DATA_DIR || DEFAULT_DATA_DIR,
    sourceDir = process.env.TG_PLUGINS_SOURCE_DIR || DEFAULT_SOURCE_DIR,
    now = () => Date.now(),
    audit = () => {},
  } = {}) {
    this.dataDir = dataDir;
    this.sourceDir = sourceDir;
    this.now = now;
    this.audit = audit;
    this.stateFile = path.join(dataDir, 'plugins.json');
    this.modulesDir = path.join(dataDir, 'modules');
    this.state = { version: STATE_VERSION, modules: {}, secrets: {}, mcp: {} };
    if (fs.existsSync(this.stateFile)) this._load();
  }

  _load() {
    let parsed;
    try {
      parsed = JSON.parse(fs.readFileSync(this.stateFile, 'utf8'));
    } catch {
      throw new Error('plugins: state file unparseable — refusing to load (fail closed)');
    }
    if (!isPlainObject(parsed) || parsed.version !== STATE_VERSION
        || !isPlainObject(parsed.modules) || !isPlainObject(parsed.secrets) || !isPlainObject(parsed.mcp)) {
      throw new Error('plugins: state file has wrong shape — refusing to load (fail closed)');
    }
    for (const [id, rec] of Object.entries(parsed.modules)) {
      const v = validateManifest(rec && rec.manifest, { dirName: id });
      if (!v.ok) throw new Error(`plugins: stored manifest for ${id} invalid — refusing to load (fail closed)`);
    }
    this.state = parsed;
  }

  _save() {
    fs.mkdirSync(this.dataDir, { recursive: true });
    const tmp = this.stateFile + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(this.state, null, 2) + '\n');
    try { fs.chmodSync(tmp, 0o600); } catch { /* best effort */ }
    fs.renameSync(tmp, this.stateFile);
    try { fs.chmodSync(this.stateFile, 0o600); } catch { /* best effort */ }
  }

  // Safe join: refuse anything escaping the base dir.
  _safeJoin(base, seg, what) {
    if (typeof seg !== 'string' || !SLUG_RE.test(seg)) {
      return { error: 'bad_' + what };
    }
    const p = path.join(base, seg);
    const rel = path.relative(base, p);
    if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return { error: 'bad_' + what };
    return { path: p };
  }

  // ── install / uninstall ──

  install(sourceId) {
    const j = this._safeJoin(this.sourceDir, sourceId, 'id');
    if (j.error) return this._reject(sourceId, [j.error]);
    if (this.state.modules[sourceId]) {
      this.audit({ type: 'plugin_rejected', id: String(sourceId), errors: ['already_installed'] });
      return { ok: false, status: 409, error: 'already_installed' };
    }
    const srcDir = j.path;
    const manifestFile = path.join(srcDir, 'plugin.json');
    if (!fs.existsSync(srcDir) || !fs.statSync(srcDir).isDirectory() || !fs.existsSync(manifestFile)) {
      return this._reject(sourceId, ['source_missing']);
    }
    let raw;
    try {
      const buf = fs.readFileSync(manifestFile);
      if (buf.length > MANIFEST_MAX) return this._reject(sourceId, ['manifest_too_large']);
      raw = JSON.parse(buf.toString('utf8'));
    } catch {
      return this._reject(sourceId, ['manifest_unparseable']);
    }
    const v = validateManifest(raw, { dirName: sourceId });
    if (!v.ok) return this._reject(sourceId, v.errors);
    if (!fs.existsSync(path.join(srcDir, v.manifest.entry))) {
      return this._reject(sourceId, ['entry_missing:' + v.manifest.entry]);
    }

    fs.mkdirSync(this.modulesDir, { recursive: true });
    const dest = path.join(this.modulesDir, sourceId);
    fs.cpSync(srcDir, dest, { recursive: true });
    this.state.modules[sourceId] = {
      manifest: v.manifest,
      enabled: false,
      installedAt: this.now(),
      dir: dest,
    };
    this._save();
    this.audit({ type: 'plugin_installed', id: sourceId, name: v.manifest.name, version: v.manifest.version });
    return { ok: true, status: 201, module: this.view(sourceId) };
  }

  _reject(id, errors) {
    this.audit({ type: 'plugin_rejected', id: String(id || ''), errors: errors.slice(0, 10) });
    return { ok: false, status: 400, error: 'manifest_rejected', errors };
  }

  uninstall(id) {
    const rec = this.state.modules[id];
    if (!rec) return { ok: false, status: 404, error: 'not_found' };
    try {
      if (rec.dir && fs.existsSync(rec.dir)) fs.rmSync(rec.dir, { recursive: true, force: true });
    } catch (e) {
      return { ok: false, status: 500, error: 'remove_failed', detail: String(e && e.message) };
    }
    delete this.state.modules[id];
    delete this.state.secrets[id];
    this._save();
    this.audit({ type: 'plugin_uninstalled', id, version: rec.manifest.version });
    return { ok: true, status: 200, uninstalled: id };
  }

  // ── enable / disable ──

  enable(id) { return this._settle(id, true); }
  disable(id) { return this._settle(id, false); }

  _settle(id, enabled) {
    const rec = this.state.modules[id];
    if (!rec) return { ok: false, status: 404, error: 'not_found' };
    rec.enabled = enabled;
    this._save();
    this.audit({
      type: enabled ? 'plugin_enabled' : 'plugin_disabled',
      id,
      version: rec.manifest.version,
      name: rec.manifest.name,
    });
    return { ok: true, status: 200, module: this.view(id) };
  }

  // ── secrets: write-only, length-only echo ──

  setSecret(id, name, value) {
    const rec = this.state.modules[id];
    if (!rec) return { ok: false, status: 404, error: 'not_found' };
    if (typeof name !== 'string' || !SECRET_NAME_RE.test(name)) {
      return { ok: false, status: 400, error: 'bad_secret_name' };
    }
    const declared = rec.manifest.secrets.find((s) => s.name === name);
    if (!declared) return { ok: false, status: 400, error: 'secret_undeclared', declared: rec.manifest.secrets.map((s) => s.name) };
    if (typeof value !== 'string' || value === '' || value.length > SECRET_VALUE_MAX) {
      return { ok: false, status: 400, error: `value must be a non-empty string ≤${SECRET_VALUE_MAX} chars` };
    }
    this.state.secrets[id] = this.state.secrets[id] || {};
    this.state.secrets[id][name] = value;
    this._save();
    // NEVER log the value — name + length only.
    this.audit({ type: 'secret_configured', id, name, length: value.length });
    return { ok: true, status: 200, secret: { name, configured: true, length: value.length } };
  }

  removeSecret(id, name) {
    const rec = this.state.modules[id];
    if (!rec) return { ok: false, status: 404, error: 'not_found' };
    const bag = this.state.secrets[id] || {};
    if (!(name in bag)) return { ok: false, status: 404, error: 'secret_not_set' };
    delete bag[name];
    this._save();
    this.audit({ type: 'secret_removed', id, name });
    return { ok: true, status: 200, removed: name };
  }

  // Internal consumer (wave B runtime). Deliberately NOT routed over HTTP.
  getSecret(id, name) {
    const bag = this.state.secrets[id];
    return bag && bag[name] !== undefined ? bag[name] : null;
  }

  // ── views (never contain secret values) ──

  list() {
    return Object.keys(this.state.modules).sort().map((id) => this.view(id));
  }

  view(id) {
    const rec = this.state.modules[id];
    if (!rec) return null;
    const bag = this.state.secrets[id] || {};
    return {
      id,
      name: rec.manifest.name,
      version: rec.manifest.version,
      description: rec.manifest.description,
      capabilities: rec.manifest.capabilities.slice(),
      enabled: rec.enabled === true,
      installedAt: rec.installedAt,
      secrets: rec.manifest.secrets.map((d) => ({
        name: d.name,
        required: d.required,
        configured: typeof bag[d.name] === 'string' && bag[d.name].length > 0,
        length: typeof bag[d.name] === 'string' ? bag[d.name].length : 0,
      })),
    };
  }

  // ── skills discovery over installed modules ──

  discoverSkills() {
    const skills = [];
    const rejected = [];
    for (const id of Object.keys(this.state.modules).sort()) {
      const rec = this.state.modules[id];
      const skillsDir = path.join(rec.dir, 'skills');
      if (!fs.existsSync(skillsDir) || !fs.statSync(skillsDir).isDirectory()) continue;
      for (const f of fs.readdirSync(skillsDir).sort()) {
        if (!f.endsWith('.md')) continue;
        const file = path.join(skillsDir, f);
        let text;
        try {
          const buf = fs.readFileSync(file);
          if (buf.length > SKILL_FILE_MAX) {
            rejected.push({ module: id, file: f, errors: ['file_too_large'] });
            continue;
          }
          text = buf.toString('utf8');
        } catch {
          rejected.push({ module: id, file: f, errors: ['unreadable'] });
          continue;
        }
        const v = parseSkillFrontmatter(text);
        if (v.ok) {
          skills.push({ module: id, file: f, ...v.skill, body: undefined });
        } else {
          rejected.push({ module: id, file: f, errors: v.errors });
        }
      }
    }
    return { skills, rejected };
  }

  // ── MCP registry ──

  registerMcp(def) {
    const v = validateMcpDef(def);
    if (!v.ok) {
      this.audit({ type: 'mcp_rejected', name: String((def && def.name) || ''), errors: v.errors.slice(0, 10) });
      return { ok: false, status: 400, error: 'mcp_rejected', errors: v.errors };
    }
    if (this.state.mcp[v.def.name]) {
      return { ok: false, status: 409, error: 'already_registered' };
    }
    const stored = { ...v.def };
    if (v.env) stored.env = v.env;
    this.state.mcp[v.def.name] = stored;
    this._save();
    this.audit({ type: 'mcp_registered', name: v.def.name, transport: v.def.transport });
    return { ok: true, status: 201, server: this.mcpView(v.def.name) };
  }

  unregisterMcp(name) {
    if (!this.state.mcp[name]) return { ok: false, status: 404, error: 'not_found' };
    delete this.state.mcp[name];
    this._save();
    this.audit({ type: 'mcp_unregistered', name });
    return { ok: true, status: 200, unregistered: name };
  }

  mcpView(name) {
    const s = this.state.mcp[name];
    if (!s) return null;
    const { env, ...rest } = s; // env VALUES never leave the store; keys only
    return rest;
  }

  listMcp() {
    return Object.keys(this.state.mcp).sort().map((n) => this.mcpView(n));
  }
}

// ── per-gateway singleton (like chat-singleton), injectable in tests ──

const hubs = new WeakMap();
function getPluginsHub(gw) {
  if (gw.pluginsHub instanceof PluginHub) return gw.pluginsHub;
  let hub = hubs.get(gw);
  if (!hub) {
    hub = new PluginHub({ audit: (payload) => gw._audit(payload) });
    gw.pluginsHub = hub;
    hubs.set(gw, hub);
  }
  return hub;
}

module.exports = {
  PluginHub,
  getPluginsHub,
  validateManifest,
  parseSkillFrontmatter,
  validateMcpDef,
  TRIGGER_MAX,
  SLUG_RE,
};
