'use strict';
// FS-C1 — skills as first-class governed objects.
//
// A Skill is a named, versioned, reviewable sequence of governed tool steps.
// A skill is a PLAYBOOK, not an execution engine: at run time every step
// flows through the SAME governed path as a chat proposal — classify →
// decide → audit → (allow ? dispatch : park as approval). A destructive
// step still parks. Nothing here bypasses policy.js or approvals.
//
// Storage: data/skills.json — atomic tmp+rename, mode 0600, refuse-to-load
// on corrupt/invalid content (fail closed). Same pattern as memory.js /
// approvals.js.
//
// Skill shape (spec):
//   { id: 'sk_<8hex>', name: unique slug, version: 'MAJOR.MINOR.PATCH',
//     description, createdBy, createdAt,
//     steps: [{ tool, argsTemplate, approvalHint }] }
//
// argsTemplate rules (chain hygiene — raw args NEVER enter the chain):
//   • '{{placeholder}}' style, e.g. 'list {{dir}}'
//   • every non-placeholder segment is structural text; shell
//     metacharacters (` ; $ | & > <) are rejected BOTH in the template
//     literals and in the values supplied for placeholders at run time
//     (same rejection pattern as voice.js TG_TTS_CMD argv-only parsing).

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const policy = require('./policy');

const DEFAULT_FILE = path.resolve(__dirname, '..', '..', 'data', 'skills.json');
const MAX_NAME_LEN = 64;
const MAX_DESC_LEN = 500;
const MAX_STEPS = 20;

const SLUG_RE = /^[a-z][a-z0-9-]*[a-z0-9]$/; // kebab-case slug, 3+ chars handled below
const SEMVER_RE = /^\d+\.\d+\.\d+$/;
const PLACEHOLDER_RE = /\{\{\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*\}\}/g;
// Shell metacharacters — identical set to voice.js parseCmdString.
const METACHAR_RE = /[;&|$`><]/;

function err(code, message) {
  const e = new Error(message);
  e.code = code;
  return e;
}

// True when `tool` matches one of policy's explicit classification rules.
// classify() maps UNKNOWN tools to 'destructive' (fail closed) — that is
// NOT the same as "classified in policy": an unrecognized tool must never
// be written into a skill.
function isClassifiedInPolicy(tool) {
  return policy.isClassified(tool);
}

// ── FS-F1: skills self-service RBAC ──────────────────────────────
// Access tier for a bot on the skills surface:
//   'operator' — full control, byte-identical FS-C1 behavior.
//   'author'   — explicit 'skill.author' cap: full CRUD/run as before (FS-C1).
//   'self'     — 'skills.own' cap: create (scoped owner=bot.name), list OWN,
//                get OWN, patch OWN, delete OWN, dry-run OWN. A non-dry run
//                is refused (approval-gated runs stay operator/author-only).
//   null       — no access (fail closed).
// Note: unlike apikeys/tenants, a '*' capability does NOT widen skills
// access — FS-C1 scoped the surface to role 'operator' or 'skill.author'
// and that contract is preserved byte-identically.
function skillsAccessLevel(bot) {
  if (!bot) return null;
  if (bot.role === 'operator') return 'operator';
  const caps = Array.isArray(bot.capabilities) ? bot.capabilities : [];
  if (caps.includes('skill.author')) return 'author';
  if (caps.includes('skills.own')) return 'self';
  return null;
}

// Ownership check: a 'self'-tier bot owns exactly the skills it created
// (createdBy === bot.name). Fail closed on anything malformed.
function isOwnSkill(skill, bot) {
  if (!skill || !bot || !bot.name) return false;
  return skill.createdBy === bot.name;
}

// ── FS-F4: skills marketplace (visibility) ──────────────────────
// A skill's visibility is 'private' (default — every skill created before
// FS-F4, and every skill created now, behaves exactly as before) or
// 'shared' (visible to other bots on the SAME gateway for reading and
// DRY-run; never editable or deletable by non-owners).
//
// ── FS-G1: cross-tenant skills federation (design-locked, additive) ──
// Federation model:
//   • A skill can be PUBLISHED FEDERATED by its OWNING tenant's OPERATOR —
//     visibility gains a third value 'federated' (set ONLY via the audited
//     federate route, never through create/update/publish).
//   • A federated skill is READABLE (name/version/owner-tenant/description
//     projection — never steps) and DRY-RUNNABLE by bots of OTHER tenants.
//   • REAL (non-dry) runs of a federated skill still flow the EXISTING
//     governed path; approval parks ride the RUNNING tenant's approval
//     store (the running tenant's operator approves — never the owner's).
//   • Edits/delete remain OWNER-TENANT-only (a cross-tenant operator is
//     answered 404 anti-enum + audited skill_federation_denied).
//   • Federation is OFF by default: TG_SKILLS_FEDERATION=1 is required for
//     every federation ROUTE and semantic; with the env unset a 'federated'
//     skill behaves EXACTLY like 'shared' (byte-identical off-switch — the
//     env is read dynamically at request time, never cached).
//   • The store stays per-gateway; the owner tenant is recorded ON the
//     skill record as `ownerTenant` (set at create when the env is on,
//     else at federate time). Cross-tenant dry runs are audited
//     skill_run_started with BOTH tags: tenantAuditTag(running tenant) AND
//     federatedFrom: <owner-tenant-id>.
function isShared(skill) {
  return !!skill && skill.visibility === 'shared';
}

// FS-G1: 'federated' visibility — always viewable/dry-runnable like
// 'shared' (env off degrades it TO shared semantics; env on adds the
// cross-tenant projection, tags and running-tenant approval routing).
function isFederated(skill) {
  return !!skill && skill.visibility === 'federated';
}

// FS-G1: shared-like = visible cross-bot. Env-independent by design (see
// isFederated above) — the env gates ROUTES and bookkeeping, not viewability.
function isSharedLike(skill) {
  return isShared(skill) || isFederated(skill);
}

// FS-G1: the federation switch. Read dynamically (never cached) so tests
// and operators can flip it without a restart; unset/'0' = OFF.
function federationEnabled() {
  return process.env.TG_SKILLS_FEDERATION === '1';
}

// Visibility-aware view check, used where FS-F1 used bare ownership:
//   • owner → sees its record (unchanged)
//   • operator/author tiers → see everything (FS-C1, unchanged)
//   • 'self' tier → additionally sees OTHER owners' records IFF the
//     record is shared. A private record owned by someone else stays
//     invisible (404 anti-enumeration, byte-identical FS-F1 behavior).
// Editing (PATCH/DELETE) and non-dry runs do NOT use this check — they
// stay strictly isOwnSkill / dry-only.
function canViewSkill(skill, bot, access) {
  if (!skill) return false;
  if (isOwnSkill(skill, bot)) return true;
  if (access === 'operator' || access === 'author') return true;
  if (access === 'self' && isSharedLike(skill)) return true; // FS-G1: federated counts as shared-like
  return false;
}

// Validate an argsTemplate:
//   • '' → no args ({} at run time)
//   • otherwise a JSON object template whose string leaves carry
//     well-formed {{name}} placeholders — e.g. {"cmd":"deploy {{target}}"}
//   • NO shell metacharacters in the literal (non-placeholder) parts of
//     any leaf — that would be raw args baked into the skill
// Returns the list of placeholder names.
function validateTemplate(template) {
  if (template === '' ) return [];
  if (typeof template !== 'string') throw err('bad_request', 'argsTemplate must be a JSON object string or empty');
  if (template.length > 2000) throw err('bad_request', 'argsTemplate too long (max 2000)');
  let obj;
  try { obj = JSON.parse(template); } catch { throw err('bad_request', 'argsTemplate must be a JSON object, e.g. {"cmd":"deploy {{target}}"}'); }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
    throw err('bad_request', 'argsTemplate must be a JSON object, e.g. {"cmd":"deploy {{target}}"}');
  }
  const names = [];
  for (const value of Object.values(obj)) {
    if (typeof value !== 'string') throw err('bad_request', 'argsTemplate values must be strings');
    const literals = value.replace(PLACEHOLDER_RE, '');
    if (METACHAR_RE.test(literals)) {
      throw err('bad_request', 'argsTemplate contains raw shell metacharacters — use {{placeholders}}, never raw args');
    }
    const stripped = literals;
    if (/\{\{|\}\}/.test(stripped)) {
      throw err('bad_request', 'argsTemplate has a malformed placeholder — use {{name}} style only');
    }
    let m;
    PLACEHOLDER_RE.lastIndex = 0;
    while ((m = PLACEHOLDER_RE.exec(value))) names.push(m[1]);
  }
  return names;
}

// Substitute {{name}} placeholders in every leaf of the JSON object
// template with values from `args` → returns the resolved args OBJECT.
// Fail closed: a missing value or a value containing shell metachars
// throws bad_request — nothing half-substituted ever reaches dispatch.
function resolveTemplate(template, args) {
  const placeholderNames = validateTemplate(template);
  if (placeholderNames.length === 0 && template === '') return {};
  const supplied = args && typeof args === 'object' ? args : {};
  const missing = placeholderNames.filter((n) => supplied[n] === undefined || supplied[n] === null);
  if (missing.length) throw err('bad_request', `missing skill args: ${missing.join(', ')}`);
  const obj = JSON.parse(template);
  const resolveLeaf = (value) => value.replace(PLACEHOLDER_RE, (_full, name) => {
    const v = String(supplied[name]);
    if (METACHAR_RE.test(v)) {
      throw err('bad_request', `skill arg '${name}' contains shell metacharacters — rejected`);
    }
    return v;
  });
  for (const k of Object.keys(obj)) obj[k] = resolveLeaf(obj[k]);
  return obj;
}

class SkillStore {
  constructor({ file = null, now = () => Date.now() } = {}) {
    this.file = file;
    this.now = now;
    this.skills = []; // array of skill objects (id-keyed lookup below)
    if (file && fs.existsSync(file)) this._load();
  }

  _load() {
    let doc;
    try {
      doc = JSON.parse(fs.readFileSync(this.file, 'utf8'));
    } catch {
      throw new Error('skills: file unparseable — refusing to load (fail closed)');
    }
    if (!doc || typeof doc !== 'object' || !Array.isArray(doc.skills)) {
      throw new Error('skills: file must be a JSON object with a skills array');
    }
    const seenIds = new Set();
    const seenNames = new Set();
    for (const s of doc.skills) {
      // Re-run the full validator: a file that no longer validates is corrupt.
      this._validate({ ...s, skipIdCheck: true });
      if (seenIds.has(s.id)) throw new Error('skills: duplicate id ' + s.id);
      if (seenNames.has(s.name)) throw new Error('skills: duplicate name ' + s.name);
      seenIds.add(s.id);
      seenNames.add(s.name);
    }
    this.skills = doc.skills.map((s) => ({ ...s }));
  }

  _save() {
    if (!this.file) return;
    const doc = { skills: this.skills };
    const dir = path.dirname(this.file);
    fs.mkdirSync(dir, { recursive: true });
    const tmp = this.file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(doc) + '\n', { mode: 0o600 });
    fs.renameSync(tmp, this.file);
    try { fs.chmodSync(this.file, 0o600); } catch { /* best effort */ }
  }

  _validate({ id, name, version, description, steps, createdBy, skipIdCheck = false }) {
    if (!skipIdCheck) {
      if (typeof id !== 'string' || !/^sk_[0-9a-f]{8}$/.test(id)) {
        throw err('bad_request', 'skill id must be sk_<8hex>');
      }
    }
    if (typeof name !== 'string' || name.length < 3 || name.length > MAX_NAME_LEN || !SLUG_RE.test(name)) {
      throw err('bad_request', 'skill name must be a 3-64 char kebab-case slug');
    }
    if (typeof version !== 'string' || !SEMVER_RE.test(version)) {
      throw err('bad_request', 'skill version must be MAJOR.MINOR.PATCH semver');
    }
    if (description !== undefined && (typeof description !== 'string' || description.length > MAX_DESC_LEN)) {
      throw err('bad_request', `skill description must be a string (max ${MAX_DESC_LEN})`);
    }
    if (typeof createdBy !== 'string' || createdBy.length === 0) {
      throw err('bad_request', 'skill createdBy required');
    }
    if (!Array.isArray(steps) || steps.length === 0 || steps.length > MAX_STEPS) {
      throw err('bad_request', `skill steps must be an array of 1..${MAX_STEPS} steps`);
    }
    for (const s of steps) {
      if (!s || typeof s !== 'object') throw err('bad_request', 'each step must be an object');
      const tool = s.tool;
      if (typeof tool !== 'string' || tool.length === 0) throw err('bad_request', 'step tool required');
      if (!isClassifiedInPolicy(tool)) {
        throw err('bad_request', `step tool '${tool}' is not classified in policy — unknown tools are forbidden`);
      }
      validateTemplate(s.argsTemplate);
      if (s.approvalHint !== undefined && typeof s.approvalHint !== 'string') {
        throw err('bad_request', 'step approvalHint must be a string');
      }
    }
  }

  list() {
    return this.skills.map((s) => ({ ...s }));
  }

  get(id) {
    const s = this.skills.find((x) => x.id === id);
    return s ? { ...s } : null;
  }

  create({ name, version, description = '', steps, createdBy }) {
    // Validate the raw input BEFORE touching it — undefined/bad steps must
    // surface as bad_request (400), never as an internal error.
    this._validate({ name, version, description, steps, createdBy, skipIdCheck: true });
    const skill = {
      id: 'sk_' + crypto.randomBytes(4).toString('hex'),
      name,
      version,
      description: description || '',
      steps: steps.map((s) => ({
        tool: s.tool,
        argsTemplate: s.argsTemplate,
        approvalHint: s.approvalHint || '',
      })),
      createdBy,
      createdAt: this.now(),
    };
    this._validate(skill);
    if (this.skills.some((s) => s.name === skill.name)) {
      throw err('conflict', `skill name '${skill.name}' already exists`);
    }
    this.skills.push(skill);
    this._save();
    return { ...skill };
  }

  update(id, { name, version, description, steps }) {
    const idx = this.skills.findIndex((s) => s.id === id);
    if (idx === -1) throw err('not_found', 'skill not found');
    const current = this.skills[idx];
    const next = {
      ...current,
      name: name !== undefined ? name : current.name,
      version: version !== undefined ? version : current.version,
      description: description !== undefined ? description : current.description,
      steps: steps !== undefined ? steps : current.steps,
    };
    this._validate(next);
    if (steps !== undefined) {
      // normalize AFTER validation — validation guarantees a 1..N array
      next.steps = steps.map((s) => ({ tool: s.tool, argsTemplate: s.argsTemplate, approvalHint: s.approvalHint || '' }));
    }
    if (this.skills.some((s, i) => i !== idx && s.name === next.name)) {
      throw err('conflict', `skill name '${next.name}' already exists`);
    }
    this.skills[idx] = next;
    this._save();
    return { ...next };
  }

  // FS-F4: flip a skill's visibility ('private' ↔ 'shared'). The field is
  // deliberately NOT settable via create/update — the only path to shared
  // is the audited publish route, so a marketplace listing can never be
  // smuggled in through a plain edit.
  setVisibility(id, visibility) {
    if (visibility !== 'private' && visibility !== 'shared') {
      throw err('bad_request', 'skill visibility must be private or shared');
    }
    const idx = this.skills.findIndex((s) => s.id === id);
    if (idx === -1) throw err('not_found', 'skill not found');
    this.skills[idx] = { ...this.skills[idx], visibility };
    this._save();
    return { ...this.skills[idx] };
  }

  // FS-G1: publish a skill FEDERATED — operator-only via the audited
  // federate route. 'federated' is deliberately unreachable through
  // setVisibility/create/update (the same anti-smuggle rule as FS-F4).
  // The owner tenant is stamped here if absent (created before the env was
  // on); an already-stamped owner tenant is NEVER overwritten.
  federate(id, ownerTenant = 'main') {
    if (!this.skills.some((s) => s.id === id)) throw err('not_found', 'skill not found');
    const idx = this.skills.findIndex((s) => s.id === id);
    const current = this.skills[idx];
    this.skills[idx] = {
      ...current,
      visibility: 'federated',
      ownerTenant: current.ownerTenant || ownerTenant,
    };
    this._save();
    return { ...this.skills[idx] };
  }

  // FS-G1: pull a skill back from federation → 'private'. The federation
  // contract is "unfederate → 404 anti-enum restored" for OTHER tenants:
  // only 'private' re-hides the skill everywhere. An operator who wants a
  // shared-but-not-federated skill uses unpublish instead.
  unfederate(id) {
    if (!this.skills.some((s) => s.id === id)) throw err('not_found', 'skill not found');
    const idx = this.skills.findIndex((s) => s.id === id);
    const current = this.skills[idx];
    this.skills[idx] = { ...current, visibility: 'private' };
    this._save();
    return { ...this.skills[idx] };
  }

  remove(id) {
    const idx = this.skills.findIndex((s) => s.id === id);
    if (idx === -1) throw err('not_found', 'skill not found');
    const [removed] = this.skills.splice(idx, 1);
    this._save();
    return { ...removed };
  }
}

// Single SkillStore instance per gateway (like artifacts / memory pattern).
const _instances = new WeakMap();
function getSkillStore(gw) {
  let s = _instances.get(gw);
  if (!s) {
    // Tests may point a gateway at an isolated file via gw._skillsFile;
    // production uses data/skills.json.
    s = new SkillStore({ file: gw._skillsFile || DEFAULT_FILE });
    _instances.set(gw, s);
  }
  return s;
}

module.exports = {
  SkillStore,
  DEFAULT_FILE,
  getSkillStore,
  isClassifiedInPolicy,
  skillsAccessLevel,
  isOwnSkill,
  isShared,
  isFederated,
  isSharedLike,
  federationEnabled,
  canViewSkill,
  validateTemplate,
  resolveTemplate,
  METACHAR_RE,
};
