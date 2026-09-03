'use strict';
// Harness v2 — project build/run loop (FS-C2).
//
// A project is a declared mini-app stored under data/harness2/<id>/:
//   manifest.json  { id, name, entry, skills: [], requiresApproval, createdAt }
//   files/         the project's source files (relative paths, depth ≤ 8)
//
// buildProject copies files/ → data/harness2/<id>/jail/ with plain
// fs.copyFileSync (rebuild = clean jail first). runProject spawns
// `node <entry>` inside the jail with run discipline copied from harness.js
// (wave B) — same guarantees, project-shaped:
//   - spawn('node', [entryAbs], { cwd: jail }) — NEVER a shell string
//   - entry is jail-resolved first (path traversal escapes_jail)
//   - env scrubbed to PATH/HOME/NODE_ENV ONLY — no secrets, no endpoints
//   - 10 s hard timeout; the child is SIGKILLed on expiry
//   - stdout/stderr tails capped at 8 KB each
//
// HONEST LIMITATION (acknowledged, same as harness.js wave B): the jail is a
// directory under the same user account. It is process-discipline (no shell,
// scrubbed env, timeout, tails), NOT an OS sandbox — a malicious entry could
// still touch files the gateway user can touch. That is why
// manifest.requiresApproval=true routes runs through the human approval
// store instead of executing them directly.

const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { jailResolve } = require('./harness');

const RUN_TIMEOUT_MS = 10_000;
const TAIL_BYTES = 8 * 1024; // 8 KB stdout/stderr tails
const MAX_TOTAL_BYTES = 256 * 1024; // 256 KB total source cap
const MAX_FILES = 128;
const MAX_PATH_DEPTH = 8;
const ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
const MANIFEST = 'manifest.json';
const FILES_DIR = 'files';
const JAIL_DIR = 'jail';

// Skill ids are plugin-skill name slugs (plugins.js parseSkillFrontmatter);
// a project manifest may declare dependencies on them. The registry is
// injected (makeHarness2({ knownSkills })) — with no registry injected,
// every declared skill is reported as a warning, never an error.
const SKILL_ID_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/; // plugin-skill slug shape (plugins.js SLUG_RE)

function tryRealpath(p) {
  try { return fs.realpathSync(p); } catch { return undefined; }
}

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return tryRealpath(dir) || path.resolve(dir);
}

function rmDirSafe(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

function tail(s) {
  if (s.length <= TAIL_BYTES) return s;
  return s.slice(-TAIL_BYTES);
}

// slugify a human name into a project id; '' when nothing usable remains
function slugify(name) {
  return String(name || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64);
}

// Strict relative-path check for keys of the `files` map (create-time).
// Returns null when safe, or a short reason string. Rejects absolute paths,
// '..' segments, NUL, backslashes, empty and trailing-slash keys. Defense in
// depth: jailResolve runs again at write time against the real files dir.
function validateRelPath(rel) {
  if (typeof rel !== 'string' || rel.length === 0 || rel.length > 255) return 'bad_path';
  if (rel.includes('\0')) return 'bad_path';
  if (rel.includes('\\')) return 'bad_path';
  if (path.isAbsolute(rel) || rel.startsWith('/')) return 'bad_path';
  const parts = rel.split('/');
  if (parts.some((p) => p === '' || p === '.' || p === '..')) return 'bad_path';
  if (parts.length > MAX_PATH_DEPTH) return 'path_too_deep';
  return null;
}

/**
 * @param {{ dataDir?: string, knownSkills?: (() => string[]) | string[], runTimeoutMs?: number }} opts
 */
function makeHarness2({ dataDir, knownSkills = null, runTimeoutMs = RUN_TIMEOUT_MS } = {}) {
  if (!dataDir) throw new Error('makeHarness2 requires { dataDir }');
  const root = path.resolve(dataDir);
  const projectDir = (id) => path.join(root, String(id));

  const knownSet = () => {
    const list = typeof knownSkills === 'function' ? knownSkills() : knownSkills;
    return new Set(Array.isArray(list) ? list : []);
  };

  function readManifest(id) {
    try {
      const raw = fs.readFileSync(path.join(projectDir(id), MANIFEST), 'utf8');
      const m = JSON.parse(raw);
      if (!m || m.id !== id) return null;
      return m;
    } catch { return null; }
  }

  function writeFileTree(filesDir, files) {
    const written = [];
    for (const rel of Object.keys(files)) {
      const dest = jailResolve(rel, filesDir);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.writeFileSync(dest, files[rel], 'utf8');
      written.push(rel);
    }
    return written;
  }

  function countFiles(dir) {
    let n = 0;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) n += countFiles(path.join(dir, entry.name));
      else if (entry.isFile()) n += 1;
    }
    return n;
  }

  // ── createProject ──────────────────────────────────────────────
  // { name, files: {relPath: content}, entry?, skills?, requiresApproval? }
  // Sync-on-disk so the mount can answer 201/4xx deterministically.
  function createProject({ name, files, entry = null, skills = null, requiresApproval = null } = {}) {
    if (typeof name !== 'string' || name.trim().length === 0 || name.length > 80) {
      return { ok: false, error: 'bad_name' };
    }
    const id = slugify(name);
    if (!ID_RE.test(id)) return { ok: false, error: 'bad_name' };
    if (!files || typeof files !== 'object' || Array.isArray(files)) {
      return { ok: false, error: 'bad_files' };
    }
    const rels = Object.keys(files);
    if (rels.length === 0 || rels.length > MAX_FILES) return { ok: false, error: 'bad_files' };
    for (const rel of rels) {
      const why = validateRelPath(rel);
      if (why) return { ok: false, error: why, path: rel };
      if (typeof files[rel] !== 'string') return { ok: false, error: 'bad_files', path: rel };
    }
    const totalBytes = rels.reduce((n, rel) => n + Buffer.byteLength(files[rel], 'utf8'), 0);
    if (totalBytes > MAX_TOTAL_BYTES) {
      return { ok: false, error: 'size_cap', totalBytes, cap: MAX_TOTAL_BYTES };
    }

    // entry: explicit, else app.js, else index.js, else the single .js file
    let entryName = typeof entry === 'string' && entry.length > 0 ? entry : null;
    if (!entryName) {
      entryName = ['app.js', 'index.js'].find((c) => rels.includes(c))
        || (rels.filter((r) => r.endsWith('.js')).length === 1 ? rels.find((r) => r.endsWith('.js')) : null);
    }
    if (typeof entryName !== 'string' || !entryName.endsWith('.js') || !rels.includes(entryName)) {
      return { ok: false, error: 'entry_missing', entry: entryName };
    }
    if (validateRelPath(entryName)) return { ok: false, error: 'bad_path', path: entryName };

    // skills: optional array of plugin-skill ids; unknown ids are warnings
    const skillList = skills === null || skills === undefined ? [] : skills;
    if (!Array.isArray(skillList) || skillList.some((s) => typeof s !== 'string' || !SKILL_ID_RE.test(s))) {
      return { ok: false, error: 'bad_skills' };
    }
    const known = knownSet();
    const warnings = skillList.filter((s) => !known.has(s)).map((s) => `unknown_skill:${s}`);

    if (fs.existsSync(projectDir(id))) return { ok: false, error: 'id_exists', id };

    const dirReal = ensureDir(projectDir(id));
    const filesDir = ensureDir(path.join(dirReal, FILES_DIR));
    const manifest = {
      id,
      name: String(name),
      entry: entryName,
      skills: skillList.slice(),
      requiresApproval: requiresApproval === true,
      createdAt: new Date().toISOString(),
    };
    writeFileTree(filesDir, files);
    fs.writeFileSync(path.join(dirReal, MANIFEST), JSON.stringify(manifest, null, 2) + '\n', 'utf8');
    return { ok: true, project: manifest, fileCount: rels.length, warnings };
  }

  // ── validateProject ────────────────────────────────────────────
  // Structural validation. Warnings never fail validation; errors do.
  function validateProject(id) {
    const manifest = readManifest(id);
    if (!manifest) return { ok: false, errors: ['not_found'], warnings: [] };
    const errors = [];
    const warnings = [];
    if (!ID_RE.test(String(manifest.id || ''))) errors.push('bad_id');
    const entry = manifest.entry;
    if (typeof entry !== 'string' || !entry.endsWith('.js') || validateRelPath(entry)) {
      errors.push('bad_entry');
    } else {
      const filesDir = path.join(projectDir(id), FILES_DIR);
      try {
        const p = jailResolve(entry, filesDir);
        if (!fs.existsSync(p)) errors.push('entry_missing');
      } catch { errors.push('bad_entry'); }
    }
    if (!Array.isArray(manifest.skills)) errors.push('bad_skills');
    else {
      const known = knownSet();
      for (const s of manifest.skills) if (!known.has(s)) warnings.push(`unknown_skill:${s}`);
    }
    return { ok: errors.length === 0, errors, warnings };
  }

  // ── listProjects / getProject ──────────────────────────────────
  function listProjects() {
    if (!fs.existsSync(root)) return [];
    const out = [];
    for (const entry of fs.readdirSync(root, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (!entry.isDirectory()) continue;
      const manifest = readManifest(entry.name);
      if (!manifest) continue;
      out.push({ ...manifest, fileCount: countFiles(path.join(projectDir(entry.name), FILES_DIR)) });
    }
    return out;
  }

  function getProject(id) {
    if (typeof id !== 'string' || !ID_RE.test(id)) return null;
    const manifest = readManifest(id);
    if (!manifest) return null;
    return { ...manifest, fileCount: countFiles(path.join(projectDir(id), FILES_DIR)) };
  }

  // ── buildProject ───────────────────────────────────────────────
  // files/ → jail/ (clean rebuild). Warnings don't block; errors do.
  function buildProject(id) {
    if (typeof id !== 'string' || !ID_RE.test(id)) return { ok: false, error: 'bad_id' };
    const manifest = readManifest(id);
    if (!manifest) return { ok: false, error: 'not_found' };
    const v = validateProject(id);
    if (!v.ok) return { ok: false, error: 'invalid_project', errors: v.errors };
    const filesDir = path.join(projectDir(id), FILES_DIR);
    const jail = path.join(projectDir(id), JAIL_DIR);
    rmDirSafe(jail);
    ensureDir(jail);
    let n = 0;
    const walk = (dir, rel) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
        const src = path.join(dir, e.name);
        const relPath = rel ? `${rel}/${e.name}` : e.name;
        if (e.isDirectory()) walk(src, relPath);
        else if (e.isFile()) {
          const dest = jailResolve(relPath, jail);
          fs.mkdirSync(path.dirname(dest), { recursive: true });
          fs.copyFileSync(src, dest);
          n += 1;
        }
      }
    };
    walk(filesDir, '');
    return { ok: true, id, dir: JAIL_DIR, fileCount: n, warnings: v.warnings };
  }

  // ── runProject ─────────────────────────────────────────────────
  // node <entry> in the jail. Env = PATH/HOME/NODE_ENV ONLY. 10 s SIGKILL.
  function runProject(id) {
    if (typeof id !== 'string' || !ID_RE.test(id)) return { ok: false, error: 'bad_id' };
    const manifest = readManifest(id);
    if (!manifest) return { ok: false, error: 'not_found' };
    const jail = path.join(projectDir(id), JAIL_DIR);
    if (!fs.existsSync(jail)) return { ok: false, error: 'not_built' };
    let entryAbs;
    try { entryAbs = jailResolve(manifest.entry, jail); } catch { return { ok: false, error: 'bad_entry' }; }
    if (!fs.existsSync(entryAbs)) return { ok: false, error: 'not_built' };

    const env = {
      PATH: process.env.PATH || '/usr/bin:/bin',
      HOME: process.env.HOME || '/tmp',
      NODE_ENV: 'production',
    };
    return new Promise((resolve) => {
      const started = Date.now();
      let child;
      try {
        child = spawn('node', [entryAbs], { cwd: jail, env, stdio: ['ignore', 'pipe', 'pipe'] });
      } catch (e) {
        return resolve({ ok: false, error: 'spawn_failed', id, message: String(e && e.message).slice(0, 200) });
      }
      let out = '';
      let err = '';
      let done = false;
      const finish = (r) => { if (!done) { done = true; clearTimeout(timer); resolve(r); } };
      const timer = setTimeout(() => {
        try { child.kill('SIGKILL'); } catch { /* already gone */ }
        finish({
          ok: true, id, exitCode: null, timedOut: true,
          stdout: tail(out), stderr: tail(err),
          durationMs: Date.now() - started,
        });
      }, runTimeoutMs);
      child.stdout.on('data', (c) => { out += c.toString('utf8'); });
      child.stderr.on('data', (c) => { err += c.toString('utf8'); });
      child.on('error', (e) => {
        finish({ ok: false, error: 'spawn_failed', id, message: String(e && e.message).slice(0, 200), durationMs: Date.now() - started });
      });
      child.on('close', (code) => {
        finish({
          ok: true, id, exitCode: code, timedOut: false,
          stdout: tail(out), stderr: tail(err),
          durationMs: Date.now() - started,
        });
      });
    });
  }

  return { createProject, validateProject, buildProject, runProject, listProjects, getProject, jailResolve, root };
}

module.exports = {
  makeHarness2, slugify, validateRelPath,
  ID_RE, RUN_TIMEOUT_MS, TAIL_BYTES, MAX_TOTAL_BYTES,
  MANIFEST, FILES_DIR, JAIL_DIR,
};
