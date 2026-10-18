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
const crypto = require('node:crypto');

const SLUG_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const SECRET_NAME_RE = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;
const SEMVER_RE = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/;
const TRIGGER_MAX = 57;
const NAME_MAX = 64;
const DESC_MAX = 200;
const SECRET_VALUE_MAX = 8192;
const MANIFEST_MAX = 64 * 1024;
const SKILL_FILE_MAX = 64 * 1024;
const PACKAGE_FILE_MAX = 2 * 1024 * 1024;
const PACKAGE_BYTES_MAX = 16 * 1024 * 1024;
const PACKAGE_FILES_MAX = 1024;
const STATE_VERSION = 1;
const CONTRACT_VERSION = '0.2';
const PLUGIN_VIEWS = new Set(['Card', 'Table', 'Form', 'Chart', 'Timeline', 'Approval', 'Progress', 'Artifact']);

const DEFAULT_SOURCE_DIR = path.join(__dirname, '..', '..', 'modules');
const DEFAULT_DATA_DIR = path.join(__dirname, '..', '..', 'data');

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function hashModuleTree(rootDir) {
  const rootStat = fs.lstatSync(rootDir);
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
    return { ok: false, errors: ['package_root_must_be_real_directory'] };
  }

  const files = [];
  let totalBytes = 0;
  const walk = (dir) => {
    const entries = fs.readdirSync(dir, { withFileTypes: true })
      .sort((a, b) => a.name.localeCompare(b.name));
    for (const ent of entries) {
      const full = path.join(dir, ent.name);
      const rel = path.relative(rootDir, full).split(path.sep).join('/');
      const st = fs.lstatSync(full);
      if (st.isSymbolicLink()) return { error: 'symlink_forbidden:' + rel };
      if (st.isDirectory()) {
        const nested = walk(full);
        if (nested) return nested;
        continue;
      }
      if (!st.isFile()) return { error: 'special_file_forbidden:' + rel };
      if (st.size > PACKAGE_FILE_MAX) return { error: 'file_too_large:' + rel };
      totalBytes += st.size;
      if (totalBytes > PACKAGE_BYTES_MAX) return { error: 'package_too_large' };
      files.push({ full, rel, size: st.size });
      if (files.length > PACKAGE_FILES_MAX) return { error: 'too_many_files' };
    }
    return null;
  };

  const walked = walk(rootDir);
  if (walked) return { ok: false, errors: [walked.error] };

  const h = crypto.createHash('sha256');
  for (const file of files.sort((a, b) => a.rel.localeCompare(b.rel))) {
    h.update(String(Buffer.byteLength(file.rel)), 'utf8');
    h.update(':', 'utf8');
    h.update(file.rel, 'utf8');
    h.update('\0', 'utf8');
    h.update(String(file.size), 'utf8');
    h.update('\0', 'utf8');
    h.update(fs.readFileSync(file.full));
    h.update('\0', 'utf8');
  }
  return {
    ok: true,
    integrity: {
      algorithm: 'sha256',
      digest: h.digest('hex'),
      fileCount: files.length,
      totalBytes,
    },
  };
}

// ── manifest validation ───────────────────────────────────────────

function validateManifest(raw, { dirName } = {}) {
  const errors = [];
  if (!isPlainObject(raw)) {
    return { ok: false, errors: ['manifest must be a JSON object'] };
  }
  const allowed = new Set([
    'contractVersion', 'id', 'name', 'version', 'entry', 'description',
    'capabilities', 'permissions', 'tools', 'views', 'events', 'automations',
    'sandbox', 'secrets', 'mcp',
  ]);
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
  if (raw.contractVersion !== undefined && !['0.1', CONTRACT_VERSION].includes(raw.contractVersion)) {
    errors.push(`contractVersion must be 0.1|${CONTRACT_VERSION}`);
  }
  if (raw.sandbox !== undefined && raw.sandbox !== 'jailed') {
    errors.push('sandbox must be "jailed"');
  }

  const normalizeStringList = (field, value) => {
    if (value === undefined) return [];
    if (!Array.isArray(value) || value.some((item) => typeof item !== 'string' || item.trim() === '' || item.length > 128)) {
      errors.push(`${field} must be an array of non-empty strings ≤128 chars`);
      return [];
    }
    return [...new Set(value.map((item) => item.trim()))];
  };

  let capabilities = [];
  if (raw.capabilities !== undefined) {
    if (!Array.isArray(raw.capabilities) || raw.capabilities.some((c) => typeof c !== 'string' || c === '')) {
      errors.push('capabilities must be an array of non-empty strings');
    } else {
      capabilities = raw.capabilities.slice();
    }
  }

  const permissions = normalizeStringList('permissions', raw.permissions);
  const tools = normalizeStringList('tools', raw.tools);
  const events = normalizeStringList('events', raw.events);

  let views = [];
  if (raw.views !== undefined) {
    if (!Array.isArray(raw.views) || raw.views.some((view) => typeof view !== 'string')) {
      errors.push('views must be an array of view primitive names');
    } else {
      for (const view of raw.views) {
        if (!PLUGIN_VIEWS.has(view)) errors.push(`unknown_view:${view}`);
        else if (!views.includes(view)) views.push(view);
      }
    }
  }

  let automations = [];
  if (raw.automations !== undefined) {
    if (!Array.isArray(raw.automations)) {
      errors.push('automations must be an array');
    } else {
      for (const automation of raw.automations) {
        if (!isPlainObject(automation)
            || typeof automation.trigger !== 'string' || automation.trigger.trim() === ''
            || typeof automation.action !== 'string' || automation.action.trim() === '') {
          errors.push('automations must contain {trigger, action} strings');
          continue;
        }
        automations.push({
          ...(typeof automation.id === 'string' && automation.id ? { id: automation.id } : {}),
          trigger: automation.trigger.trim(),
          ...(typeof automation.condition === 'string' && automation.condition ? { condition: automation.condition } : {}),
          action: automation.action.trim(),
        });
      }
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
      contractVersion: raw.contractVersion || CONTRACT_VERSION,
      id,
      name: name.trim(),
      version,
      entry,
      description: raw.description || '',
      capabilities,
      permissions,
      tools,
      views,
      events,
      automations,
      sandbox: raw.sandbox || 'jailed',
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
    fs.writeFileSync(tmp, JSON.stringify(this.state) + '\n');
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
    if (!fs.existsSync(srcDir) || !fs.existsSync(manifestFile)) {
      return this._reject(sourceId, ['source_missing']);
    }
    let srcStat;
    let manifestStat;
    try {
      srcStat = fs.lstatSync(srcDir);
      manifestStat = fs.lstatSync(manifestFile);
    } catch {
      return this._reject(sourceId, ['source_missing']);
    }
    if (srcStat.isSymbolicLink() || !srcStat.isDirectory()) {
      return this._reject(sourceId, ['source_must_be_real_directory']);
    }
    if (manifestStat.isSymbolicLink() || !manifestStat.isFile()) {
      return this._reject(sourceId, ['manifest_must_be_real_file']);
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
    const entryFile = path.join(srcDir, v.manifest.entry);
    if (!fs.existsSync(entryFile)) {
      return this._reject(sourceId, ['entry_missing:' + v.manifest.entry]);
    }
    const entryStat = fs.lstatSync(entryFile);
    if (entryStat.isSymbolicLink() || !entryStat.isFile()) {
      return this._reject(sourceId, ['entry_must_be_real_file:' + v.manifest.entry]);
    }

    const sourceSeal = hashModuleTree(srcDir);
    if (!sourceSeal.ok) return this._reject(sourceId, sourceSeal.errors);

    fs.mkdirSync(this.modulesDir, { recursive: true });
    const dest = path.join(this.modulesDir, sourceId);
    if (fs.existsSync(dest)) {
      return this._reject(sourceId, ['install_destination_exists']);
    }
    const staging = dest + '.tmp-' + process.pid + '-' + crypto.randomBytes(6).toString('hex');
    try {
      fs.cpSync(srcDir, staging, { recursive: true, dereference: false, errorOnExist: true, force: false });
      const copiedSeal = hashModuleTree(staging);
      if (!copiedSeal.ok || copiedSeal.integrity.digest !== sourceSeal.integrity.digest) {
        return this._reject(sourceId, copiedSeal.ok ? ['install_copy_digest_mismatch'] : copiedSeal.errors);
      }

      // Re-parse the staged manifest after the content seal. This closes the
      // parse→hash/copy TOCTOU window: the manifest we persist must describe
      // the exact bytes that became the installed snapshot.
      let stagedManifest;
      try {
        stagedManifest = JSON.parse(fs.readFileSync(path.join(staging, 'plugin.json'), 'utf8'));
      } catch {
        return this._reject(sourceId, ['install_manifest_unparseable']);
      }
      const stagedValidation = validateManifest(stagedManifest, { dirName: sourceId });
      if (!stagedValidation.ok
          || JSON.stringify(stagedValidation.manifest) !== JSON.stringify(v.manifest)) {
        return this._reject(sourceId, ['install_manifest_changed_during_copy']);
      }

      fs.renameSync(staging, dest);
    } catch {
      return this._reject(sourceId, ['install_copy_failed']);
    } finally {
      if (fs.existsSync(staging)) {
        try { fs.rmSync(staging, { recursive: true, force: true }); } catch { /* best effort */ }
      }
    }

    this.state.modules[sourceId] = {
      manifest: v.manifest,
      enabled: false,
      installedAt: this.now(),
      dir: dest,
      integrity: sourceSeal.integrity,
    };
    this._save();
    this.audit({
      type: 'plugin_installed',
      id: sourceId,
      name: v.manifest.name,
      version: v.manifest.version,
      packageDigest: sourceSeal.integrity.digest,
    });
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

    if (enabled) {
      const bag = this.state.secrets[id] || {};
      const missing = rec.manifest.secrets
        .filter((secret) => secret.required && !(typeof bag[secret.name] === 'string' && bag[secret.name].length > 0))
        .map((secret) => secret.name);
      if (missing.length) {
        this.audit({ type: 'plugin_enable_refused', id, reason: 'required_secrets_missing', missing });
        return { ok: false, status: 409, error: 'required_secrets_missing', missing };
      }

      if (rec.integrity && rec.integrity.algorithm === 'sha256') {
        let current;
        try {
          current = hashModuleTree(rec.dir);
        } catch {
          current = { ok: false, errors: ['integrity_read_failed'] };
        }
        if (!current.ok || current.integrity.digest !== rec.integrity.digest) {
          this.audit({
            type: 'plugin_integrity_mismatch',
            id,
            expected: rec.integrity.digest,
            observed: current.ok ? current.integrity.digest : null,
          });
          return { ok: false, status: 409, error: 'plugin_integrity_mismatch' };
        }
      }
    }

    rec.enabled = enabled;
    this._save();
    this.audit({
      type: enabled ? 'plugin_enabled' : 'plugin_disabled',
      id,
      version: rec.manifest.version,
      name: rec.manifest.name,
      packageDigest: rec.integrity?.digest || null,
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
      contractVersion: rec.manifest.contractVersion || '0.1',
      capabilities: rec.manifest.capabilities.slice(),
      permissions: (rec.manifest.permissions || []).slice(),
      tools: (rec.manifest.tools || []).slice(),
      views: (rec.manifest.views || []).slice(),
      events: (rec.manifest.events || []).slice(),
      automations: (rec.manifest.automations || []).map((automation) => ({ ...automation })),
      sandbox: rec.manifest.sandbox || 'jailed',
      enabled: rec.enabled === true,
      installedAt: rec.installedAt,
      integrity: rec.integrity ? { ...rec.integrity, sealed: true } : { sealed: false },
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
  hashModuleTree,
  CONTRACT_VERSION,
  PLUGIN_VIEWS,
  TRIGGER_MAX,
  SLUG_RE,
};
