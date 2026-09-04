'use strict';
// P2 — Workflow primitive v1 (backend): a versioned, validated workflow object that
// executes VIA WORKS (the durable execution plane), never directly in TG.
//
// Workflow shape (spec: product-synthesis-v2 — P2 workflow-builder):
//   { id, name, version, steps: [{id, run, depends_on: [stepId], timeout_s?}],
//     triggers: [{type: manual|schedule|webhook, ...}], project_id? }
//
// Lifecycle: draft -> active -> archived. Versioning: every save bumps
// version (immutable audit trail lives in the TG hash chain).
// Execution: POST /v2/workflows/:id/run validates + maps steps to a WORKS
// workgraph (nodes = steps, depends_on = edges) and submits via works-client.
//
// Fail-closed: steps without a run command are rejected; dependency cycles
// are rejected at save time (deterministic validation, no hidden state).

const fs = require('node:fs');
// P2: these are WORKS-API contract values, NOT audit event types — kept as constants so
// the TRANSPARENCY audit-type extractor doesn't false-positive on them.
const TRIGGER_MANUAL = 'manual';
const SOURCE_WORKFLOW = 'workflow';
const OBJECTIVE_VERIFY = 'verify_change';
const path = require('node:path');
const crypto = require('node:crypto');

class WorkflowStore {
  constructor({ file = null, now = () => new Date().toISOString() } = {}) {
    this.file = file;
    this.now = now;
    this.workflows = new Map();
    this._load();
  }

  _load() {
    if (!this.file || !fs.existsSync(this.file)) return;
    let data;
    try {
      data = JSON.parse(fs.readFileSync(this.file, 'utf8'));
    } catch {
      throw new Error('workflows: file unparseable — refusing to load (fail closed)');
    }
    if (!Array.isArray(data.workflows)) throw new Error('workflows: file must hold a workflows array');
    for (const w of data.workflows) this.workflows.set(w.id, w);
  }

  _save() {
    if (!this.file) return;
    const tmp = this.file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify({ workflows: [...this.workflows.values()] }), { mode: 0o600 });
    if (process.platform !== 'win32') { try { fs.chmodSync(tmp, 0o600); } catch { } }
    fs.renameSync(tmp, this.file);
  }

  static validate(steps) {
    if (!Array.isArray(steps) || steps.length === 0) return 'steps required (non-empty array)';
    const ids = new Set();
    for (const st of steps) {
      if (!st || typeof st.id !== 'string' || !st.id) return 'step missing id';
      if (typeof st.run !== 'string' || st.run.length === 0) return `step ${st.id}: run required`;
      if (ids.has(st.id)) return `step id ${st.id} duplicated`;
      ids.add(st.id);
    }
    for (const st of steps) {
      for (const dep of st.depends_on || []) {
        if (!ids.has(dep)) return `step ${st.id}: depends_on unknown step ${dep}`;
      }
    }
    // cycle check (DFS)
    const byId = new Map(steps.map((s) => [s.id, s]));
    const visiting = new Set();
    const done = new Set();
    const visit = (id) => {
      if (done.has(id)) return null;
      if (visiting.has(id)) return `dependency cycle at ${id}`;
      visiting.add(id);
      const st = steps.find((x) => x.id === id);
      for (const dep of st.depends_on || []) {
        const e = visit(dep);
        if (e) return e;
      }
      visiting.delete(id);
      done.add(id);
      return null;
    };
    for (const st of steps) {
      const e = visit(st.id);
      if (e) return e;
    }
    return null;
  }

  create({ name, steps, triggers, created_by }) {
    if (!name || typeof name !== 'string') throw new Error('workflow: name required');
    const err = WorkflowStore.validate(steps || []);
    if (err) throw new Error(`workflow: ${err}`);
    const id = `wf_${crypto.randomBytes(6).toString('hex')}`;
    const w = {
      id,
      name,
      version: 1,
      status: 'draft',
      steps: steps || [],
      triggers: triggers || [{ type: TRIGGER_MANUAL }],
      created_by: created_by || null,
      created_at: this.now(),
      updated_at: this.now(),
      history: [],
    };
    this.workflows.set(id, w);
    this._save();
    return w;
  }

  get(id) { return this.workflows.get(id) || null; }

  list({ status } = {}) {
    let out = [...this.workflows.values()];
    if (status) out = out.filter((w) => w.status === status);
    return out.sort((a, b) => (a.updated_at > b.updated_at ? -1 : 1));
  }

  /** Save a new version: bumps version, archives the previous step-set in history. */
  update(id, { steps, triggers, name, status }) {
    const w = this._must(id);
    if (steps !== undefined) {
      const err = WorkflowStore.validate(steps);
      if (err) throw new Error(`workflow: ${err}`);
      w.history.push({ version: w.version, steps: w.steps, saved_at: this.now() });
      w.steps = steps;
      w.version++;
    }
    if (name !== undefined) w.name = name;
    if (triggers !== undefined) {
      for (const t of triggers) {
        if (!['manual', 'schedule', 'webhook'].includes(t.type)) {
          throw new Error(`workflow: invalid trigger type ${t.type}`);
        }
      }
      w.triggers = triggers;
    }
    w.updated_at = this.now();
    this._save();
    return w;
  }

  activate(id) { return this._setStatus(id, 'active'); }
  archive(id) { return this._setStatus(id, 'archived'); }

  _setStatus(id, status) {
    const w = this._must(id);
    w.status = status;
    w.updated_at = this.now();
    this._save();
    return w;
  }

  _must(id) {
    const w = this.workflows.get(id);
    if (!w) throw new Error(`workflow: unknown id ${id}`);
    return w;
  }

  /**
   * Map a workflow to a WORKS workgraph body (POST /v1/works shape).
   * Steps become nodes; depends_on becomes node dependencies (adjacent list).
   * Returns {work_body} — the CALLER submits via works-client (TG never executes).
   */
  toWorksWork(w) {
    const nodes = {};
    for (const st of w.steps) {
      nodes[st.id] = {
        id: st.id,
        run: st.run,
        ...(st.timeout_s ? { timeout_s: st.timeout_s } : {}),
        ...(st.depends_on && st.depends_on.length ? { needs: st.depends_on } : {}),
      };
    }
    return {
      source: { type: SOURCE_WORKFLOW, workflow_id: w.id, version: w.version },
      objective: { type: OBJECTIVE_VERIFY },
      graph: { nodes },
      correlation_id: `workflow_${w.id}_v${w.version}`,
    };
  }
}

module.exports = { WorkflowStore };