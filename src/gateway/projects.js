'use strict';
// P1 — Project primitive v1 (G-project gap closer).
// Canonical contract: product-synthesis-v2/06-PROJECTS-MISSIONS-TASKS.md §1.
// A Project is the persistent working context binding conversations, missions,
// needs-you signals, blockers and activity. TG owns the object; WORKS owns
// execution; correlation happens by storing Work IDs in running_work.
//
// ponytail: JSON-file store (same pattern as missions.js); SQLite upgrade path
// rides on the W0.1 conversations db when the stores merge.

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const STATUSES = new Set(['active', 'archived', 'on_hold']);
const HEALTHS = new Set(['healthy', 'degraded', 'blocked']);

class ProjectStore {
  constructor({ file, now } = {}) {
    this.file = file;
    this.now = now || (() => new Date().toISOString());
    this.projects = new Map();
    this._load();
  }

  _load() {
    if (!this.file || !fs.existsSync(this.file)) return;
    let data;
    try {
      data = JSON.parse(fs.readFileSync(this.file, 'utf8'));
    } catch {
      throw new Error('projects: refusing to load corrupt file (fail closed)');
    }
    for (const p of data.projects || []) this.projects.set(p.id, p);
  }

  _save() {
    if (!this.file) return;
    const tmp = this.file + '.tmp';
    const fd = fs.openSync(tmp, 'w', 0o600);
    try {
      fs.writeFileSync(fd, JSON.stringify({ projects: [...this.projects.values()] }));
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(tmp, this.file);
  }

  create({ title, description, goal, owner }) {
    if (!title || typeof title !== 'string') throw new Error('project: title required');
    const id = `project_${crypto.randomBytes(6).toString('hex')}`;
    const p = {
      id,
      title,
      description: description || '',
      status: 'active',
      goal: goal || '',
      health: 'healthy',
      running_work: [],
      needs_you: [],
      blockers: [],
      recent_activity: [],
      next_actions: [],
      conversations: [],
      missions: [],
      created_at: this.now(),
      updated_at: this.now(),
      owner: null,
    };
    this.projects.set(id, p);
    this._save();
    return p;
  }

  get(id) { return this.projects.get(id) || null; }

  list({ status } = {}) {
    let out = [...this.projects.values()];
    if (status) out = out.filter((p) => p.status === status);
    return out.sort((a, b) => (a.updated_at > b.updated_at ? -1 : 1));
  }

  /** attach a conversation/mission id to the project (correlation, G3-style). */
  attach(id, kind, refId) {
    const p = this._must(id);
    if (!['conversations', 'missions'].includes(kind)) throw new Error(`project: invalid kind ${kind}`);
    const arr = p[kind];
    if (!arr.includes(refId)) arr.push(refId);
    p.updated_at = this.now();
    this._save();
    return p;
  }

  /** record activity (work_completed | mission_admitted | evidence_verified | human_decision). */
  logActivity(id, type, description) {
    const p = this._must(id);
    const valid = ['work_completed', 'mission_admitted', 'evidence_verified', 'human_decision'];
    if (!valid.includes(type)) throw new Error(`project: invalid activity type ${type}`);
    p.recent_activity.unshift({ timestamp: this.now(), type, description });
    // keep the recent tail bounded — it's a "recent activity" surface, not a ledger
    if (p.recent_activity.length > 50) p.recent_activity.length = 50;
    p.updated_at = this.now();
    this._save();
    return p;
  }

  /** Needs You signals: {approval_request} | {human_input} | {budget_action} (>=1 key). */
  addNeedsYou(id, signal) {
    const p = this._must(id);
    const keys = ['approval_request', 'human_input', 'budget_action'].filter((k) => k in signal);
    if (keys.length === 0) throw new Error('project: needs_you signal requires one of approval_request/human_input/budget_action');
    p.needs_you.push({ ...signal, added_at: this.now() });
    p.updated_at = this.now();
    this._save();
    return p;
  }

  resolveNeedsYou(id, index) {
    const p = this._must(id);
    const removed = p.needs_you.splice(index, 1);
    p.updated_at = this.now();
    this._save();
    return { p, removed };
  }

  setHealth(id, health) {
    const p = this._must(id);
    if (!HEALTHS.has(health)) throw new Error(`project: invalid health ${health}`);
    p.health = health;
    p.updated_at = this.now();
    this._save();
    return p;
  }

  addBlocker(id, { type, description, blocking_work }) {
    const p = this._must(id);
    if (!['technical', 'dependency', 'policy', 'budget'].includes(type)) {
      throw new Error(`project: invalid blocker type ${type}`);
    }
    p.blockers.push({ type, description, blocking_work: blocking_work_or(blocking_work) });
    if (p.status === 'active') p.health = 'degraded';
    p.updated_at = this.now();
    this._save();
    return p;

    function blocking_work_or(w) { return Array.isArray(w) ? w : []; }
  }

  resolveBlocker(id, index) {
    const p = this._must(id);
    const b = p.blockers.splice(index, 1)[0];
    if (p.blockers.length === 0 && p.status === 'active') p.health = 'healthy';
    p.updated_at = this.now();
    this._save();
    return p;
  }

  setStatus(id, status) {
    const p = this._must(id);
    if (!STATUSES.has(status)) throw new Error(`project: invalid status ${status}`);
    p.status = status;
    p.updated_at = this.now();
    this._save();
    return p;
  }

  _must(id) {
    const p = this.projects.get(id);
    if (!p) throw new Error(`project: unknown id ${id}`);
    return p;
  }
}

module.exports = { ProjectStore, STATUSES, HEALTHS };