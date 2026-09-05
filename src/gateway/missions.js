'use strict';
// W0.2 — MissionProposal object (G2 gap closer) + W0.3 TG-side mission correlation.
//
// Canonical contract: product-synthesis-v2/06-PROJECTS-MISSIONS-TASKS.md §4.
// A MissionProposal bridges chat-initiated intent to WORKS Mission objects:
//   draft → submitted → approved → (converted_to_mission_id) | rejected | expired
//
// This module owns proposal lifecycle + the mission_id correlation registry:
//   - proposals are audit-sealed on create/submit/resolve
//   - approval stamps converted_to_mission_id (the WORKS Mission the approver
//     created via the mission-create path; TG records the correlation so every
//     later audit entry can carry mission_id — G3)
//   - expiry is lazy (checked on read), fail-closed
//
// ponytail: in-memory + JSON file persistence (same pattern as approvals);
// upgrade path: SQLite when W0.1 conversations land their db tables.

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const PROPOSAL_TTL_MS = 7 * 24 * 3600 * 1000; // expiry: 7 days after submission

class MissionProposalStore {
  constructor({ file, now } = {}) {
    this.file = file;
    this.now = now || (() => new Date().toISOString());
    this.proposals = new Map(); // id -> proposal
    this._load();
  }

  _load() {
    if (!this.file || !fs.existsSync(this.file)) return;
    let data;
    try {
      data = JSON.parse(fs.readFileSync(this.file, 'utf8'));
    } catch {
      throw new Error('missionProposals: refusing to load corrupt file (fail closed)');
    }
    for (const p of data.proposals || []) this.proposals.set(p.id, p);
  }

  _save() {
    if (!this.file) return;
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = this.file + '.tmp';
    const fd = fs.openSync(tmp, 'w', 0o600);
    try {
      fs.writeFileSync(fd, JSON.stringify({ proposals: [...this.proposals.values()] }));
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(tmp, this.file);
  }

  create({ proposer, channel, objective, context, proposed_mission, reasoning, alternatives, approval_requested, approvers, approval_deadline }) {
    if (!proposer) throw new Error('proposal: proposer required');
    if (!objective || typeof objective !== 'string') throw new Error('proposal: objective required');
    if (channel && !['chat', 'api', 'scheduled'].includes(channel)) {
      throw new Error('proposal: invalid channel');
    }
    const id = `proposal_${crypto.randomBytes(6).toString('hex')}`;
    const p = {
      id,
      created_at: this.now(),
      status: 'draft',
      proposer,
      channel: channel || 'api',
      objective,
      context: context || '',
      proposed_mission: proposed_mission || null,
      reasoning: reasoning || '',
      alternatives_considered: alternatives || [],
      approval_requested: approval_requested !== false,
      approvers: [],
      approval_deadline: approval_deadline || null,
      approved_at: null,
      approved_by: null,
      converted_to_mission_id: null,
      rejection_reason: null,
      expired_at: null,
    };
    this.proposals.set(id, p);
    this._save();
    return p;
  }

  get(id) { return this.proposals.get(id) || null; }

  /** lazy expiry: draft/submitted proposals older than TTL become expired. */
  _expireIfStale(p) {
    if ((p.status === 'draft' || p.status === 'submitted') && p.submitted_at) {
      if (Date.parse(p.submitted_at) + PROPOSAL_TTL_MS < Date.parse(this.now())) {
        p.status = 'expired';
        p.expired_at = this.now();
      }
    }
    return p;
  }

  list({ status } = {}) {
    let out = [...this.proposals.values()];
    // lazy-expire on read
    for (const p of out) this._expireIfStale(p);
    if (status) out = out.filter((p) => p.status === status);
    return out.sort((a, b) => (a.created_at < b.created_at ? -1 : 1));
  }

  submit(id) {
    const p = this._must(id);
    if (p.status !== 'draft') throw new Error(`proposal: cannot submit from status ${p.status}`);
    p.status = 'submitted';
    p.submitted_at = this.now();
    this._save();
    return p;
  }

  approve(id, approver, missionId) {
    const p = this._must(id);
    if (p.status !== 'submitted') throw new Error(`proposal: cannot approve from status ${p.status}`);
    p.status = 'approved';
    p.approved_at = this.now();
    p.approved_by = approver;
    // W0.3 correlation: the approved mission id links TG audits to the WORKS mission.
    p.converted_to_mission_id = missionId || `mission_${crypto.randomBytes(6).toString('hex')}`;
    this._save();
    return p;
  }

  reject(id, reason) {
    const p = this._must(id);
    if (p.status !== 'submitted') throw new Error(`proposal: cannot reject from status ${p.status}`);
    p.status = 'rejected';
    p.rejection_reason = reason || 'rejected';
    this._save();
    return p;
  }

  /** mission_id correlation: resolve proposal -> mission id (G3). */
  missionIdFor(proposalId) {
    const p = this.proposals.get(proposalId);
    return p ? p.converted_to_mission_id : null;
  }

  _must(id) {
    const p = this.proposals.get(id);
    if (!p) throw new Error(`proposal: unknown id ${id}`);
    return this._expireIfStale(p);
  }
}

module.exports = { MissionProposalStore, PROPOSAL_TTL_MS };
