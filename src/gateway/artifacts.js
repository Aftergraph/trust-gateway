'use strict';
// Trust Gateway v2 — Artifacts (W5). First-class outputs of the workforce:
// code, docs, image refs, reports. Every artifact is versioned: a PUT never
// destroys history, it appends to versions[]. Persistence mirrors
// src/gateway/approvals.js: own JSON file under data/, atomic tmp+rename,
// mode 0600, refuse-to-load-on-corrupt (fail closed).
//
// Artifact shape:
//   { id, kind: code|doc|image-ref|report, title, content, bot, sessionRef,
//     version, createdAt, updatedAt, versions: [{ v, ts, bot, title, content, hash }] }
//
// The store is pure state (no gateway dependency); the mount layer does
// gw._audit() + hub.broadcast('artifact', ...). The store is an EventEmitter
// so per-artifact SSE streams can subscribe to 'update' for live follow-along.

const fs = require('node:fs');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { canonical, sha256 } = require('./hash-chain');

const KINDS = Object.freeze(['code', 'doc', 'image-ref', 'report']);
const MAX_TITLE = 200;
const MAX_CONTENT = 128 * 1024; // 128 KB per artifact content

function versionHash(id, version, ts, bot, title, content) {
  return sha256(`${id}|${version}|${ts}|${bot ?? ''}|${canonical({ title, content })}`);
}

class ArtifactStore extends EventEmitter {
  constructor({ file = null, now = () => Date.now() } = {}) {
    super();
    this.file = file;
    this.now = now;
    this.artifacts = new Map(); // id -> artifact
    this._next = 1;
    if (file && fs.existsSync(file)) this._load();
  }

  // ── persistence (fail closed) ──────────────────────────────────
  _load() {
    let arr;
    try {
      arr = JSON.parse(fs.readFileSync(this.file, 'utf8'));
    } catch {
      throw new Error('artifacts: file unparseable — refusing to load (fail closed)');
    }
    if (!Array.isArray(arr)) throw new Error('artifacts: file must be a JSON array');
    for (const a of arr) {
      if (!a || typeof a.id !== 'string') throw new Error('artifacts: entry missing id');
      if (!KINDS.includes(a.kind)) throw new Error(`artifacts: entry ${a.id} has unknown kind`);
      if (!Array.isArray(a.versions) || a.versions.length === 0)
        throw new Error(`artifacts: entry ${a.id} has no versions`);
      this.artifacts.set(a.id, a);
      const n = Number(a.id.replace(/^art_/, ''));
      if (Number.isFinite(n) && n >= this._next) this._next = n + 1;
    }
  }

  _save() {
    if (!this.file) return;
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = this.file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify([...this.artifacts.values()]) + '\n');
    fs.renameSync(tmp, this.file);
    try { fs.chmodSync(this.file, 0o600); } catch { /* best effort */ }
  }

  // ── API ────────────────────────────────────────────────────────
  create({ kind, title, content, bot = null, sessionRef = null } = {}) {
    if (!KINDS.includes(kind)) return { ok: false, error: 'bad_kind' };
    if (typeof title !== 'string' || title.length < 1 || title.length > MAX_TITLE)
      return { ok: false, error: 'bad_title' };
    if (typeof content !== 'string' || content.length < 1 || content.length > MAX_CONTENT)
      return { ok: false, error: 'bad_content' };
    if (sessionRef !== null && (typeof sessionRef !== 'string' || sessionRef.length < 1 || sessionRef.length > 64))
      return { ok: false, error: 'bad_sessionRef' };
    const id = `art_${String(this._next++).padStart(6, '0')}`;
    const ts = this.now();
    const v1 = {
      v: 1, ts, bot: bot ?? null, title, content,
      hash: versionHash(id, 1, ts, bot ?? null, title, content),
    };
    const art = {
      id, kind, title, content, bot: bot ?? null, sessionRef: sessionRef ?? null,
      version: 1, createdAt: ts, updatedAt: ts, versions: [v1],
    };
    this.artifacts.set(id, art);
    this._save();
    this.emit('update', { action: 'created', artifact: art, version: v1 });
    return { ok: true, artifact: art };
  }

  // Versioned PUT — appends a new version, never rewrites history.
  putVersion(id, { bot = null, title = null, content = null } = {}) {
    const art = this.artifacts.get(id);
    if (!art) return { ok: false, error: 'not_found' };
    if (title === null && content === null) return { ok: false, error: 'empty_update' };
    if (title !== null && (typeof title !== 'string' || title.length < 1 || title.length > MAX_TITLE))
      return { ok: false, error: 'bad_title' };
    if (content !== null && (typeof content !== 'string' || content.length < 1 || content.length > MAX_CONTENT))
      return { ok: false, error: 'bad_content' };
    const ts = this.now();
    const nextV = art.version + 1;
    const nextTitle = title !== null ? title : art.title;
    const nextContent = content !== null ? content : art.content;
    const v = {
      v: nextV, ts, bot: bot ?? null, title: nextTitle, content: nextContent,
      hash: versionHash(id, nextV, ts, bot ?? null, nextTitle, nextContent),
    };
    art.title = nextTitle;
    art.content = nextContent;
    art.version = nextV;
    art.updatedAt = ts;
    art.versions.push(v);
    this._save();
    this.emit('update', { action: 'updated', artifact: art, version: v });
    return { ok: true, artifact: art, version: v };
  }

  get(id) {
    return this.artifacts.get(id) ?? null;
  }

  list({ kind = null, bot = null, sessionRef = null } = {}) {
    let out = [...this.artifacts.values()];
    if (kind) out = out.filter((a) => a.kind === kind);
    if (bot) out = out.filter((a) => a.bot === bot);
    if (sessionRef) out = out.filter((a) => a.sessionRef === sessionRef);
    return out;
  }

  // Compact projection for SSE frames / list views (no version bodies).
  static project(art) {
    return {
      id: art.id, kind: art.kind, title: art.title, bot: art.bot,
      sessionRef: art.sessionRef, version: art.version,
      createdAt: art.createdAt, updatedAt: art.updatedAt,
      versionCount: art.versions.length,
    };
  }
}

// One durable store per gateway instance (WeakMap, mirrors chat-singleton.js).
// File location: TG_ARTIFACTS_FILE env override, else <repo>/data/artifacts.json.
const artifactStores = new WeakMap();
function getArtifactStore(gw) {
  let st = artifactStores.get(gw);
  if (!st) {
    const file = process.env.TG_ARTIFACTS_FILE
      || path.join(__dirname, '..', '..', 'data', 'artifacts.json');
    st = new ArtifactStore({ file, now: () => (gw && gw.now ? gw.now() : Date.now()) });
    artifactStores.set(gw, st);
  }
  return st;
}

module.exports = { ArtifactStore, KINDS, MAX_TITLE, MAX_CONTENT, versionHash, getArtifactStore };
