'use strict';
// Trust Gateway v2 — wave F F1: first-class Run + Step objects.
//
// A Run is one governed execution episode (an llm-loop deep turn, a
// single-turn brain proposal, a harness app run). Steps are the per-turn
// records inside it. Stored state (approvals.js pattern):
//
//   data/runs.json         — { <runId>: Run, ..., "steps": { <stepId>: Step } }
//                            atomic tmp+rename, mode 0600, fail-closed on
//                            corrupt load. Run ids always match /^r_[0-9a-f]{8}$/
//                            so the reserved "steps" key can never collide.
//   data/run-by-goal.json  — { <goalId>: [runId, ...] } index for the future
//                            Graph view (pure derived index; rebuilt entries
//                            are removed with their run on eviction).
//
// Run shape:  {id:'r_<8hex>', goalId?, engine:'llm-loop'|'planner'|'harness',
//   session?, bot, startedAt, endedAt?, state:'queued'|'running'|'paused'|
//   'completed'|'failed'|'canceled', steps:[StepId], exitCode?, artifacts:[]}
// Step shape: {id:'s_<8hex>', runId, seq, startedAt, endedAt?,
//   kind:'plan'|'action'|'observation', tool?, argsDigest?, decision?:
//   'allow'|'deny'|'needs_approval', resultDigest?, error?, approvalId?}
//
// Payload hygiene: argsDigest/resultDigest = sha256(plaintext)[:16]. The
// store NEVER persists tool args or results — callers pass plaintext for
// digesting and it is dropped immediately. Humans correlate digests against
// the audit chain (chat_action / chat_llm entries), which carries its own
// metadata-only payloads.
//
// Audit events: exactly THREE new chain types — run_started, run_completed,
// run_paused — for cancellable-state transitions only. Per-step events flow
// through the existing chat_action / approval_requested / chat_action_executed
// entries; the Step objects themselves are audited nowhere (they are state,
// not decisions).
//
// Registry: getRuns(gw) is a per-gateway singleton (WeakMap, chat-singleton
// pattern). It honors a pre-assigned `gw.runs` (dependency injection for
// tests and for harness authors) and exposes the store back as `gw.runs`.

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const STEPS_KEY = 'steps';
const MAX_RUNS = 200;
const RUNS_FILE = process.env.TG_RUNS_FILE || null;
const RUN_BY_GOAL_FILE = process.env.TG_RUN_BY_GOAL_FILE || null;

function sha256Hex(s) {
  return crypto.createHash('sha256').update(String(s)).digest('hex');
}
// sha256(plaintext)[:16] — correlate, never carry.
function digestOf(plaintext) {
  if (plaintext === undefined || plaintext === null) return null;
  return sha256Hex(typeof plaintext === 'string' ? plaintext : JSON.stringify(plaintext)).slice(0, 16);
}
function hex8() {
  return crypto.randomBytes(4).toString('hex'); // 8 lowercase hex chars
}

function err(code, message) {
  const e = new Error(message);
  e.code = code;
  return e;
}

const RUN_STATES = ['queued', 'running', 'paused', 'completed', 'failed', 'canceled'];
const STEP_KINDS = ['plan', 'action', 'observation'];

class RunStore {
  constructor({ file = null, goalIndexFile = null, now = () => Date.now(), maxRuns = MAX_RUNS, gw = null } = {}) {
    this.file = file ?? RUNS_FILE;
    this.goalIndexFile = goalIndexFile ?? RUN_BY_GOAL_FILE;
    this.now = now;
    this.maxRuns = maxRuns;
    this.gw = gw; // set by getRuns() — audit sink (gw._audit)
    this.runs = new Map();   // runId -> Run
    this.steps = new Map();  // stepId -> Step
    this.byGoal = new Map(); // goalId -> [runId]
    if (this.file && fs.existsSync(this.file)) this._load();
    if (this.goalIndexFile && fs.existsSync(this.goalIndexFile)) this._loadGoalIndex();
  }

  // ── persistence (approvals.js pattern: tmp+rename, 0600, fail closed) ──

  _load() {
    let doc;
    try {
      doc = JSON.parse(fs.readFileSync(this.file, 'utf8'));
    } catch {
      throw err('corrupt_store', 'runs: file unparseable — refusing to load (fail closed)');
    }
    if (!doc || typeof doc !== 'object' || Array.isArray(doc)) {
      throw err('corrupt_store', 'runs: file must be a JSON object');
    }
    for (const [key, val] of Object.entries(doc)) {
      if (key === STEPS_KEY) {
        if (!val || typeof val !== 'object' || Array.isArray(val)) {
          throw err('corrupt_store', 'runs: steps must be an object');
        }
        for (const [sid, s] of Object.entries(val)) {
          if (!s || typeof s.id !== 'string' || typeof s.runId !== 'string') {
            throw err('corrupt_store', 'runs: step entry missing id/runId');
          }
          this.steps.set(sid, s);
        }
        continue;
      }
      if (!/^r_[0-9a-f]{8}$/.test(key)) {
        throw err('corrupt_store', `runs: unexpected key '${key}' (expected r_<8hex> or "${STEPS_KEY}")`);
      }
      if (!val || typeof val.id !== 'string' || !Array.isArray(val.steps) || !RUN_STATES.includes(val.state)) {
        throw err('corrupt_store', `runs: ${key} is not a valid Run`);
      }
      this.runs.set(key, val);
    }
  }

  _save() {
    if (!this.file) return;
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const doc = {};
    for (const [id, r] of this.runs) doc[id] = r;
    doc[STEPS_KEY] = Object.fromEntries(this.steps);
    const tmp = this.file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(doc) + '\n');
    fs.renameSync(tmp, this.file);
    try { fs.chmodSync(this.file, 0o600); } catch { /* best effort */ }
  }

  _loadGoalIndex() {
    let obj;
    try {
      obj = JSON.parse(fs.readFileSync(this.goalIndexFile, 'utf8'));
    } catch {
      return; // index is derived — a corrupt index is rebuilt, not fatal
    }
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return;
    for (const [gid, rids] of Object.entries(obj)) {
      if (Array.isArray(rids)) this.byGoal.set(gid, rids.filter((id) => typeof id === 'string'));
    }
  }

  _saveGoalIndex() {
    if (!this.goalIndexFile) return;
    fs.mkdirSync(path.dirname(this.goalIndexFile), { recursive: true });
    const obj = Object.fromEntries(this.byGoal);
    const tmp = this.goalIndexFile + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(obj) + '\n');
    fs.renameSync(tmp, this.goalIndexFile);
    try { fs.chmodSync(this.goalIndexFile, 0o600); } catch { /* best effort */ }
  }

  _audit(payload) {
    if (this.gw && typeof this.gw._audit === 'function') this.gw._audit(payload);
  }

  _evict() {
    while (this.runs.size > this.maxRuns) {
      let oldest = null;
      for (const r of this.runs.values()) {
        if (!oldest || r.startedAt < oldest.startedAt) oldest = r;
      }
      if (!oldest) break;
      for (const sid of oldest.steps) this.steps.delete(sid);
      if (oldest.goalId) {
        const list = this.byGoal.get(oldest.goalId);
        if (list) {
          const i = list.indexOf(oldest.id);
          if (i >= 0) list.splice(i, 1);
          if (list.length === 0) this.byGoal.delete(oldest.goalId);
        }
      }
      this.runs.delete(oldest.id);
    }
    if (this.runs.size > 0) this._save();
    if (this.goalIndexFile) this._saveGoalIndex();
  }

  // ── run lifecycle ──────────────────────────────────────────

  runStart(engine, { session = null, bot = null, goalId = null } = {}) {
    if (!['llm-loop', 'planner', 'harness'].includes(engine)) {
      throw err('bad_engine', `runs: unknown engine '${engine}'`);
    }
    const botName = typeof bot === 'string' ? bot : (bot && bot.name) || null;
    let id = `r_${hex8()}`;
    while (this.runs.has(id)) id = `r_${hex8()}`; // collision-proof (8 hex = 2^32)
    const run = {
      id,
      goalId: goalId || null,
      engine,
      session: session || null,
      bot: botName,
      startedAt: this.now(),
      endedAt: null,
      state: 'running',
      steps: [],
      exitCode: null,
      artifacts: [],
    };
    this.runs.set(id, run);
    if (goalId) {
      if (!this.byGoal.has(goalId)) this.byGoal.set(goalId, []);
      this.byGoal.get(goalId).push(id);
    }
    this._evict(); // FIFO cap BEFORE first save, so eviction needs no second pass
    this._audit({ type: 'run_started', runId: id, engine, session: run.session, bot: botName, goalId: run.goalId });
    return run;
  }

  // Record one completed loop turn as a Step. `args`/`result` are plaintext
  // for digesting ONLY — never persisted. Returns the Step or null when the
  // run is unknown.
  runStep(runId, { kind, tool, args, decision, result, error, approvalId } = {}) {
    const run = this.runs.get(runId);
    if (!run) return null;
    const k = kind || 'action';
    if (!STEP_KINDS.includes(k)) throw err('bad_kind', `runs: unknown step kind '${k}'`);
    let sid = `s_${hex8()}`;
    while (this.steps.has(sid)) sid = `s_${hex8()}`;
    const step = {
      id: sid,
      runId,
      seq: run.steps.length,
      startedAt: this.now(),
      endedAt: this.now(), // steps are recorded after their turn completes
      kind: k,
      tool: tool || null,
      argsDigest: digestOf(args),
      decision: decision || null,
      resultDigest: digestOf(result),
      error: error || null,
      approvalId: approvalId || null,
    };
    this.steps.set(sid, step);
    run.steps.push(sid);
    this._save();
    return step;
  }

  // Close the run. state defaults: exitCode 0/absent → completed, else failed.
  // 'paused' (and 'canceled' via cancel()) emit run_paused — the cancellable-
  // state transitions. Everything else emits run_completed with its state.
  runEnd(runId, { exitCode, state, artifacts } = {}) {
    const run = this.runs.get(runId);
    if (!run) return null;
    if (RUN_END_TERMINAL.has(run.state)) return run; // already closed
    run.endedAt = this.now();
    run.exitCode = exitCode === undefined ? null : exitCode;
    run.artifacts = Array.isArray(artifacts) ? artifacts : (run.artifacts || []);
    run.state = RUN_STATES.includes(state) ? state
      : (run.exitCode === null || run.exitCode === 0 ? 'completed' : 'failed');
    this._save();
    if (run.state === 'paused') {
      this._audit({ type: 'run_paused', runId: run.id, bot: run.bot, engine: run.engine });
    } else {
      this._audit({ type: 'run_completed', runId: run.id, bot: run.bot, state: run.state, exitCode: run.exitCode });
    }
    return run;
  }

  // Operator/owner cancel → state 'canceled', audited as run_paused.
  // Only cancellable from a live state.
  cancel(runId) {
    const run = this.runs.get(runId);
    if (!run) return null;
    if (run.state !== 'running' && run.state !== 'queued' && run.state !== 'paused') return null;
    run.state = 'canceled';
    run.endedAt = this.now();
    this._save();
    this._audit({ type: 'run_paused', runId: run.id, bot: run.bot, verb: 'cancel' });
    return run;
  }

  // ── queries ────────────────────────────────────────────────

  get(id) {
    return this.runs.get(id) || null;
  }

  step(id) {
    return this.steps.get(id) || null;
  }

  // Latest-first list, projected with inline steps. Default last 50.
  list({ bot, state, goalId, limit = 50 } = {}) {
    let results = [...this.runs.values()];
    if (bot) results = results.filter((r) => r.bot === bot);
    if (state) results = results.filter((r) => r.state === state);
    if (goalId) results = results.filter((r) => r.goalId === goalId);
    results.sort((a, b) => b.startedAt - a.startedAt);
    return results.slice(0, limit).map((r) => this._withSteps(r));
  }

  getById(id) {
    const run = this.runs.get(id);
    return run ? this._withSteps(run) : null;
  }

  goalRuns(goalId) {
    return (this.byGoal.get(goalId) || []).map((id) => this.runs.get(id)).filter(Boolean);
  }

  _withSteps(run) {
    return { ...run, steps: run.steps.map((sid) => this.steps.get(sid)).filter(Boolean) };
  }
}

const RUN_END_TERMINAL = new Set(['completed', 'failed', 'canceled']);

// ── per-gateway registry (chat-singleton pattern) ────────────────
// getRuns(gw): returns the gateway's RunStore. A pre-assigned `gw.runs`
// (constructor option or test injection) always wins; otherwise one store
// is created lazily, wired to gw._audit, and exposed back as gw.runs so
// harness authors and operators can reach it without touching server.js.
const stores = new WeakMap();
function getRuns(gw) {
  if (!gw) throw err('no_gateway', 'runs: getRuns(gw) requires a gateway');
  if (gw.runs instanceof RunStore) {
    if (!gw.runs.gw) gw.runs.gw = gw; // injected store still audits into this chain
    return gw.runs;
  }
  let s = stores.get(gw);
  if (!s) {
    s = new RunStore({ now: typeof gw.now === 'function' ? () => gw.now() : undefined, gw });
    stores.set(gw, s);
    try { gw.runs = s; } catch { /* read-only host — WeakMap still works */ }
  }
  return s;
}

module.exports = { RunStore, getRuns, digestOf, MAX_RUNS, RUN_STATES, STEP_KINDS, STEPS_KEY };