'use strict';
// Trust Gateway — custom-agent store (W3 builder).
// Named custom agents: {name, role, capabilities, persona, createdAt}.
//
// Rules (PLATFORM-ABI v2 wave A):
//   - Capabilities are validated against policy ROLE_CAPABILITIES: a custom
//     agent may only hold caps that its declared role legitimately grants.
//     Invented capabilities (anything not in ROLE_CAPABILITIES[role], and
//     meta-caps like '*' or 'approval.decide') are rejected — no invented caps.
//   - Privileged caps (destructive/secret class per policy.classify, e.g.
//     'shell.run') or the 'operator' role itself require an operator caller:
//     non-operator attempts fail closed with error 'operator_required'
//     (mounts map this to 403 + audit approval_forbidden).
//   - Durability: optional JSON file under data/ — atomic tmp+rename,
//     mode 0600, refuse-to-load-on-corrupt (fail closed). Pattern copied
//     from src/gateway/approvals.js.
//   - Custom agents are a REGISTRY in wave A: they do not get tokens and are
//     not added to gw.bots (runtime provisioning lands in wave B). No tokens
//     are ever stored or returned here.
//   - Per-bot profiles: {who, persona, settings, updatedAt} — text/settings
//     only, never secrets. A bot may read/write only its own profile;
//     operators (canApprove) may access any profile.

const fs = require('node:fs');
const path = require('node:path');
const { classify, ROLE_CAPABILITIES, capabilitiesFor } = require('./policy');
const { canApprove } = require('./rbac');

const NAME_RE = /^[a-z][a-z0-9-]{1,31}$/;
const MAX_PERSONA = 2000;
const MAX_SETTINGS_BYTES = 8 * 1024;

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

// A capability is privileged when it grants destructive or secret power
// (policy classify is fail-closed: unknown → destructive → privileged).
function isPrivilegedCap(cap) {
  const cls = classify(cap);
  return cls === 'destructive' || cls === 'secret';
}

// Validate a candidate agent record. Returns {ok:true, agent} or
// {ok:false, error:code}. `reservedNames` (optional fn) lets callers block
// collisions with configured bots.
function validateAgent(input, { reservedNames = null, existing = null } = {}) {
  const name = input.name;
  if (typeof name !== 'string' || !NAME_RE.test(name)) return { ok: false, error: 'invalid_name' };
  if (reservedNames && reservedNames().includes(name)) return { ok: false, error: 'name_reserved' };

  const role = input.role;
  if (typeof role !== 'string' || !Object.prototype.hasOwnProperty.call(ROLE_CAPABILITIES, role)) {
    return { ok: false, error: 'invalid_role' };
  }

  let caps;
  if (input.capabilities === undefined) {
    caps = capabilitiesFor(role); // role defaults
  } else {
    if (!Array.isArray(input.capabilities)) return { ok: false, error: 'invalid_capabilities' };
    const allowed = ROLE_CAPABILITIES[role];
    caps = [];
    for (const c of input.capabilities) {
      if (typeof c !== 'string' || !allowed.includes(c)) return { ok: false, error: 'invalid_capability' };
      if (!caps.includes(c)) caps.push(c); // dedupe, preserve order
    }
  }

  let persona = null;
  if (input.persona !== undefined && input.persona !== null) {
    if (typeof input.persona !== 'string' || input.persona.length > MAX_PERSONA) {
      return { ok: false, error: 'invalid_persona' };
    }
    persona = input.persona;
  }

  const agent = { name, role, capabilities: caps, persona, createdAt: input.createdAt };
  return { ok: true, agent, privileged: role === 'operator' || caps.some(isPrivilegedCap) };
}

function validateProfilePatch(patch) {
  const out = {};
  if (patch.persona !== undefined) {
    if (patch.persona !== null && (typeof patch.persona !== 'string' || patch.persona.length > MAX_PERSONA)) {
      return { ok: false, error: 'invalid_persona' };
    }
    out.persona = patch.persona === null ? null : patch.persona;
  }
  if (patch.settings !== undefined) {
    if (!isPlainObject(patch.settings)) return { ok: false, error: 'invalid_settings' };
    // JSON round-trip: strips non-JSON values, keeps payloads plain.
    let rt;
    try { rt = JSON.parse(JSON.stringify(patch.settings)); } catch { return { ok: false, error: 'invalid_settings' }; }
    if (JSON.stringify(rt).length > MAX_SETTINGS_BYTES) return { ok: false, error: 'invalid_settings' };
    for (const k of Object.keys(rt)) {
      if (k === '__proto__' || k === 'prototype' || k === 'constructor') {
        return { ok: false, error: 'invalid_settings' };
      }
    }
    out.settings = rt;
  }
  if (Object.keys(out).length === 0) return { ok: false, error: 'empty_update' };
  return { ok: true, patch: out };
}

class AgentStore {
  constructor({ file = null, now = () => Date.now(), reservedNames = null } = {}) {
    this.file = file;
    this.now = now;
    this.reservedNames = reservedNames;
    this.agents = new Map();   // name -> agent
    this.profiles = new Map(); // who -> profile
    if (file && fs.existsSync(file)) this._load();
  }

  _load() {
    let data;
    try {
      data = JSON.parse(fs.readFileSync(this.file, 'utf8'));
    } catch {
      throw new Error('agent-store: file unparseable — refusing to load (fail closed)');
    }
    // Accept legacy bare-array (agents only) or {version, agents, profiles}.
    const rows = Array.isArray(data) ? data : (data && Array.isArray(data.agents) ? data.agents : null);
    if (!rows) throw new Error('agent-store: file must be an array or {agents:[...]} — refusing to load');
    for (const a of rows) {
      const v = validateAgent(a);
      if (!v.ok || v.agent.name !== a.name || v.agent.createdAt !== a.createdAt) {
        throw new Error(`agent-store: stored agent "${a && a.name}" invalid — refusing to load (fail closed)`);
      }
      this.agents.set(a.name, a);
    }
    const profiles = !Array.isArray(data) && data && isPlainObject(data.profiles) ? data.profiles : {};
    for (const [who, p] of Object.entries(profiles)) {
      if (!isPlainObject(p) || typeof who !== 'string') {
        throw new Error('agent-store: stored profile invalid — refusing to load');
      }
      this.profiles.set(who, p);
    }
  }

  _save() {
    if (!this.file) return;
    const payload = {
      version: 1,
      agents: [...this.agents.values()],
      profiles: Object.fromEntries(this.profiles),
    };
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = this.file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(payload, null, 2) + '\n');
    fs.renameSync(tmp, this.file);
    try { fs.chmodSync(this.file, 0o600); } catch { /* best effort */ }
  }

  list() {
    return [...this.agents.values()].slice().sort((a, b) => a.createdAt - b.createdAt || (a.name < b.name ? -1 : 1));
  }

  get(name) {
    return this.agents.get(name) || null;
  }

  create({ name, role, capabilities, persona }, caller) {
    const v = validateAgent({ name, role, capabilities, persona, createdAt: this.now() }, {
      reservedNames: this.reservedNames,
    });
    if (!v.ok) return v;
    if (v.privileged && !canApprove(caller)) return { ok: false, error: 'operator_required', privileged: true };
    if (this.agents.has(name)) return { ok: false, error: 'exists' };
    this.agents.set(v.agent.name, v.agent);
    this._save();
    return { ok: true, agent: v.agent };
  }

  update(name, patch, caller) {
    const existing = this.agents.get(name);
    if (!existing) return { ok: false, error: 'not_found' };
    if (!isPlainObject(patch)) return { ok: false, error: 'invalid_body' };
    if (patch.name !== undefined && patch.name !== name) return { ok: false, error: 'name_immutable' };
    // Privilege escalation check FIRST: even a validation-invalid patch that
    // tries to attach privileged caps or the operator role fails closed with
    // operator_required (403 + audit), not a validation error.
    const escalation = (patch.role === 'operator')
      || (Array.isArray(patch.capabilities) && patch.capabilities.some(isPrivilegedCap));
    if (escalation && !canApprove(caller)) return { ok: false, error: 'operator_required', privileged: true };
    const merged = {
      name,
      role: patch.role !== undefined ? patch.role : existing.role,
      capabilities: patch.capabilities !== undefined ? patch.capabilities : existing.capabilities,
      persona: patch.persona !== undefined ? patch.persona : existing.persona,
      createdAt: existing.createdAt,
    };
    const v = validateAgent(merged, { reservedNames: this.reservedNames });
    if (!v.ok) return v;
    if (v.privileged && !canApprove(caller)) return { ok: false, error: 'operator_required', privileged: true };
    this.agents.set(name, v.agent);
    this._save();
    return { ok: true, agent: v.agent };
  }

  // Deletion is a privileged, stateful decision — operator only.
  remove(name, caller) {
    if (!canApprove(caller)) return { ok: false, error: 'operator_required' };
    const existing = this.agents.get(name);
    if (!existing) return { ok: false, error: 'not_found' };
    this.agents.delete(name);
    this.profiles.delete(name);
    this._save();
    return { ok: true, agent: existing };
  }

  // ── profiles ──────────────────────────────────────────────────────
  getProfile(who, caller) {
    if (!canApprove(caller) && !(caller && caller.name === who)) {
      return { ok: false, error: 'operator_required' };
    }
    const p = this.profiles.get(who);
    return {
      ok: true,
      profile: p || { who, persona: null, settings: {}, updatedAt: null },
    };
  }

  setProfile(who, patch, caller) {
    if (!canApprove(caller) && !(caller && caller.name === who)) {
      return { ok: false, error: 'operator_required' };
    }
    const v = validateProfilePatch(patch);
    if (!v.ok) return v;
    const prev = this.profiles.get(who) || { who, persona: null, settings: {}, updatedAt: null };
    const next = {
      who,
      persona: v.patch.persona !== undefined ? v.patch.persona : prev.persona,
      settings: v.patch.settings !== undefined ? v.patch.settings : prev.settings,
      updatedAt: this.now(),
    };
    this.profiles.set(who, next);
    this._save();
    return { ok: true, profile: next, fields: Object.keys(v.patch) };
  }
}

// One store per gateway instance. Default file: <repo>/data/agents.json
// (override with TG_DATA_DIR). Lazy — no I/O until first use.
const stores = new WeakMap();
function getStore(gw) {
  let s = stores.get(gw);
  if (!s) {
    const dir = process.env.TG_DATA_DIR
      || path.join(__dirname, '..', '..', 'data');
    s = new AgentStore({
      file: path.join(dir, 'agents.json'),
      now: gw.now,
      reservedNames: () => Object.keys(gw.bots || {}),
    });
    stores.set(gw, s);
  }
  return s;
}

module.exports = {
  AgentStore,
  getStore,
  validateAgent,
  validateProfilePatch,
  isPrivilegedCap,
  NAME_RE,
  MAX_PERSONA,
  MAX_SETTINGS_BYTES,
};