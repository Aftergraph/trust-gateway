'use strict';
// Trust Gateway v2 — Continuity: goals, governed steps, loops, slash commands.
// W10. Durable state lives in data/continuity.json: atomic tmp+rename,
// mode 0600, refuse-to-load-on-corrupt (fail closed) — same pattern as
// src/gateway/approvals.js.
//
// Design:
//  - A Goal is {id, text, status, owner, steps[], loop}. Steps carry
//    {tool, state, attempts, lastDecision} and are advanced one at a time
//    through the SAME policy pipeline the action API uses: classify() then
//    decide() against the OWNER bot's capabilities. Nothing executes outside
//    that gate; every transition is audited (goal_* events).
//  - A loop is a goal-local scheduler: setInterval (unref'd so it never
//    holds the process open), each tick advances exactly one governed step.
//    The loop stops on the first DENY (fail closed), when the goal is done,
//    or at maxRuns. Timers are injectable for deterministic tests.
//  - Approval integration: when decide() says needs_approval we park an
//    ApprovalStore request; the server's existing /v1/approvals/:id/approve
//    flow executes the parked tool after the seal. We subscribe to gw 'audit'
//    and fold approval_resolved back into step state (done|denied) so a
//    restart-safe approval can never orphan a step.
//  - The JSON file keeps step args (like pending approvals keep args); API
//    projections strip them — argument VALUES never leave the box (ABI rule 5).

const fs = require('node:fs');
const path = require('node:path');
const { classify, decide } = require('./policy');
const { canApprove } = require('./rbac');

const DEFAULT_FILE = path.resolve(__dirname, '..', '..', 'data', 'continuity.json');
const GOAL_STATUSES = new Set(['active', 'paused', 'done', 'cleared']);
const STEP_STATES = new Set(['pending', 'awaiting_approval', 'running', 'done', 'denied']);
const LOOP_DEFAULT_EVERY_MS = 60_000;
const LOOP_DEFAULT_MAX_RUNS = 100;

function err(code, message) {
  const e = new Error(message);
  e.code = code;
  return e;
}

// ── Persistence ────────────────────────────────────────────────────

class ContinuityStore {
  constructor({ file = null, now = () => Date.now() } = {}) {
    this.file = file;
    this.now = now;
    this.goals = new Map(); // id -> goal
    this._next = 1;
    if (file && fs.existsSync(file)) this._load();
  }

  _load() {
    let doc;
    try {
      doc = JSON.parse(fs.readFileSync(this.file, 'utf8'));
    } catch {
      throw err('corrupt_store', 'continuity: file unparseable — refusing to load (fail closed)');
    }
    if (!doc || typeof doc !== 'object' || !Array.isArray(doc.goals))
      throw err('corrupt_store', 'continuity: file must be {version, goals:[...]}');
    for (const g of doc.goals) {
      if (!g || typeof g.id !== 'string')
        throw err('corrupt_store', 'continuity: goal entry missing id');
      if (!GOAL_STATUSES.has(g.status))
        throw err('corrupt_store', `continuity: goal ${g.id} has unknown status ${g.status}`);
      if (!Array.isArray(g.steps))
        throw err('corrupt_store', `continuity: goal ${g.id} steps must be an array`);
      for (const s of g.steps) {
        if (!s || typeof s.tool !== 'string' || !STEP_STATES.has(s.state))
          throw err('corrupt_store', `continuity: goal ${g.id} has an invalid step`);
      }
      this.goals.set(g.id, g);
      const n = Number(g.id.replace(/^goal_/, ''));
      if (Number.isFinite(n) && n >= this._next) this._next = n + 1;
    }
  }

  save(goals = this.goals.values()) {
    if (!this.file) return;
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const doc = { version: 1, savedAt: this.now(), goals: [...goals] };
    const tmp = this.file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(doc) + '\n', { mode: 0o600 });
    fs.renameSync(tmp, this.file);
    try { fs.chmodSync(this.file, 0o600); } catch { /* best effort */ }
  }
}

// ── Engine ─────────────────────────────────────────────────────────

class GoalEngine {
  constructor({
    gw = null,
    file = null,
    now = (gw && gw.now) || (() => Date.now()),
    setIntervalFn = setInterval,
    clearIntervalFn = clearInterval,
  } = {}) {
    this.gw = gw;
    this.store = new ContinuityStore({ file, now });
    this.now = now;
    this._setInterval = setIntervalFn;
    this._clearInterval = clearIntervalFn;
    this._loops = new Map();      // goalId -> { timerId }
    this._busy = new Set();       // goalIds with an in-flight tick (no overlap)
    if (gw && typeof gw.on === 'function') {
      gw.on('audit', (entry) => this._onAuditEntry(entry));
    }
  }

  _audit(payload) {
    if (this.gw && typeof this.gw._audit === 'function') return this.gw._audit(payload);
    return null;
  }

  _save() { this.store.save(); }

  // ── goals ──

  add({ text, owner, steps = [], bot = null } = {}) {
    if (typeof text !== 'string' || text.trim().length === 0)
      throw err('bad_request', 'goal text required');
    if (text.length > 500) throw err('bad_request', 'goal text too long (max 500)');
    if (!Array.isArray(steps) || steps.length > 100)
      throw err('bad_request', 'steps must be an array (max 100)');
    const normSteps = steps.map((s) => {
      if (!s || typeof s.tool !== 'string' || s.tool.length === 0 || s.tool.length > 128)
        throw err('bad_request', 'each step needs a tool name');
      return {
        tool: s.tool,
        args: s.args === undefined ? null : s.args,
        state: 'pending',
        attempts: 0,
        lastDecision: null,
        approvalId: null,
        updatedAt: this.now(),
      };
    });
    const own = owner || (bot && bot.name) || null;
    if (!own || typeof own !== 'string') throw err('bad_request', 'goal owner required');
    const id = `goal_${String(this.store._next++).padStart(6, '0')}`;
    const goal = {
      id,
      text: text.trim(),
      status: 'active',
      owner: own,
      steps: normSteps,
      loop: null, // {everyMs, maxRuns, runs} once a loop starts
      createdAt: this.now(),
      updatedAt: this.now(),
    };
    this.store.goals.set(id, goal);
    this._save();
    this._audit({
      type: 'goal_added',
      goalId: id,
      owner: own,
      by: bot ? bot.name : null,
      stepCount: normSteps.length,
      text: goal.text,
    });
    return goal;
  }

  get(id) {
    const g = this.store.goals.get(id);
    if (!g) throw err('not_found', `no such goal: ${id}`);
    return g;
  }

  list({ includeCleared = false } = {}) {
    return [...this.store.goals.values()].filter((g) => includeCleared || g.status !== 'cleared');
  }

  _guard(goal, bot, action) {
    // Owner or operator only for lifecycle changes. Policy still governs
    // execution separately — this guard is about who may touch the record.
    if (!bot) throw err('unauthorized', `${action}: authentication required`);
    if (bot.name === goal.owner || canApprove(bot)) return;
    throw err('forbidden', `${action}: only ${goal.owner} or an operator may ${action} this goal`);
  }

  pause(id, bot) {
    const g = this.get(id);
    this._guard(g, bot, 'pause');
    if (g.status !== 'active') throw err('conflict', `goal ${id} is ${g.status}, not active`);
    g.status = 'paused';
    g.updatedAt = this.now();
    this.stopLoop(id, 'paused');
    this._save();
    this._audit({ type: 'goal_paused', goalId: id, by: bot.name });
    return g;
  }

  resume(id, bot) {
    const g = this.get(id);
    this._guard(g, bot, 'resume');
    if (g.status !== 'paused') throw err('conflict', `goal ${id} is ${g.status}, not paused`);
    g.status = 'active';
    g.updatedAt = this.now();
    this._save();
    this._audit({ type: 'goal_resumed', goalId: id, by: bot.name });
    return g;
  }

  clear(id, bot) {
    const g = this.get(id);
    this._guard(g, bot, 'clear');
    g.status = 'cleared';
    g.updatedAt = this.now();
    this.stopLoop(id, 'cleared');
    this._save();
    this._audit({ type: 'goal_cleared', goalId: id, by: bot.name });
    return g;
  }

  // ── steps: the policy gate ──

  async takeStep(id) {
    const g = this.get(id);
    if (g.status !== 'active')
      throw err('conflict', `goal ${id} is ${g.status}; only active goals advance`);
    const idx = g.steps.findIndex((s) => s.state === 'pending');
    if (idx === -1) {
      const already = g.status === 'done';
      if (!already) {
        g.status = 'done';
        g.updatedAt = this.now();
        this._save();
        this._audit({ type: 'goal_completed', goalId: id, owner: g.owner });
      }
      this.stopLoop(id, 'goal_done');
      return { goal: g, done: true, step: null };
    }
    const step = g.steps[idx];
    const ownerBot = this.gw && this.gw.bots ? this.gw.bots[g.owner] : null;
    const cls = classify(step.tool);
    // Fail closed if the owner vanished (deleted bot): treat as unknown bot.
    const verdict = ownerBot
      ? decide({ tool: step.tool, cls, bot: ownerBot })
      : { decision: 'deny', reason: `owner bot ${g.owner} not configured` };
    step.attempts += 1;
    step.updatedAt = this.now();

    if (verdict.decision === 'deny') {
      step.state = 'denied';
      step.lastDecision = 'deny';
      g.updatedAt = this.now();
      this._save();
      this._audit({
        type: 'goal_step_denied',
        goalId: id, stepIndex: idx, owner: g.owner,
        tool: step.tool, class: cls, reason: verdict.reason, attempts: step.attempts,
      });
      return { goal: g, done: false, denied: true, step, stepIndex: idx, verdict };
    }

    if (verdict.decision === 'needs_approval') {
      const args = { goalId: id, stepIndex: idx, owner: g.owner, ...(step.args && typeof step.args === 'object' ? step.args : {}) };
      const approval = this.gw.approvals.request({
        bot: { name: g.owner },
        tool: step.tool,
        args,
        reason: `goal ${id} step ${idx}: ${verdict.reason}`,
      });
      step.state = 'awaiting_approval';
      step.lastDecision = 'needs_approval';
      step.approvalId = approval.id;
      g.updatedAt = this.now();
      this._save();
      this._audit({
        type: 'goal_step_awaiting_approval',
        goalId: id, stepIndex: idx, owner: g.owner,
        tool: step.tool, class: cls, approvalId: approval.id, reason: verdict.reason,
      });
      return { goal: g, done: false, approvalId: approval.id, step, stepIndex: idx, verdict };
    }

    // allow → execute through the gateway dispatcher (may throw).
    step.state = 'running';
    this._save();
    let ok = false;
    let error = null;
    if (!this.gw || typeof this.gw.dispatch !== 'function') {
      error = 'no_dispatcher';
    } else {
      try {
        const args = { goalId: id, stepIndex: idx, ...(step.args && typeof step.args === 'object' ? step.args : {}) };
        await this.gw.dispatch(g.owner, step.tool, args);
        ok = true;
      } catch (e) {
        error = String((e && e.message) || e);
      }
    }
    step.state = ok ? 'done' : 'pending'; // failed execution stays pending for retry
    step.lastDecision = 'allow';
    g.updatedAt = this.now();
    this._save();
    this._audit({
      type: 'goal_stepped',
      goalId: id, stepIndex: idx, owner: g.owner,
      tool: step.tool, class: cls, decision: 'allow', ok, error: error || undefined,
    });
    return { goal: g, done: false, step, stepIndex: idx, verdict: { decision: 'allow', reason: verdict.reason } };
  }

  // Approval flow folds back into step state via the audit stream.
  _onAuditEntry(entry) {
    const p = entry && entry.payload;
    if (!p || p.type !== 'approval_resolved' || !p.ok || !p.approvalId) return;
    for (const g of this.store.goals.values()) {
      const idx = g.steps.findIndex((s) => s.state === 'awaiting_approval' && s.approvalId === p.approvalId);
      if (idx === -1) continue;
      const step = g.steps[idx];
      if (p.verb === 'approve') {
        step.state = 'done';
        step.lastDecision = 'approved';
        step.approvalId = null;
        g.updatedAt = this.now();
        this._save();
        this._audit({
          type: 'goal_stepped',
          goalId: g.id, stepIndex: idx, owner: g.owner,
          tool: step.tool, decision: 'approved', ok: true, approvalId: p.approvalId,
        });
      } else if (p.verb === 'deny') {
        step.state = 'denied';
        step.lastDecision = 'deny';
        step.approvalId = null;
        g.updatedAt = this.now();
        this._save();
        this._audit({
          type: 'goal_step_denied',
          goalId: g.id, stepIndex: idx, owner: g.owner,
          tool: step.tool, decision: 'denied', approvalId: p.approvalId,
        });
        this.stopLoop(g.id, 'denied');
      }
      return;
    }
  }

  // ── loops ──

  startLoop(id, { everyMs = LOOP_DEFAULT_EVERY_MS, maxRuns = LOOP_DEFAULT_MAX_RUNS } = {}, bot = null) {
    const g = this.get(id);
    this._guard(g, bot, 'loop.start');
    if (g.status !== 'active') throw err('conflict', `goal ${id} is ${g.status}; loops run only on active goals`);
    if (this._loops.has(id)) throw err('conflict', `goal ${id} loop already running`);
    if (!Number.isFinite(everyMs) || everyMs < 5 || everyMs > 24 * 3600_000)
      throw err('bad_request', 'everyMs out of range (5ms..24h)');
    if (!Number.isInteger(maxRuns) || maxRuns < 1 || maxRuns > 100000)
      throw err('bad_request', 'maxRuns must be an integer 1..100000');
    g.loop = { everyMs, maxRuns, runs: 0 };
    g.updatedAt = this.now();
    this._save();
    const timer = this._setInterval(() => { this._tick(id); }, everyMs);
    if (timer && typeof timer.unref === 'function') timer.unref(); // never hold the process
    this._loops.set(id, { timerId: timer });
    this._audit({ type: 'goal_loop_started', goalId: id, everyMs, maxRuns, owner: g.owner });
    return g;
  }

  stopLoop(id, reason = 'manual') {
    const l = this._loops.get(id);
    if (!l) return false;
    try { this._clearInterval(l.timerId); } catch { /* ignore */ }
    this._loops.delete(id);
    const g = this.store.goals.get(id);
    this._save();
    this._audit({ type: 'goal_loop_stopped', goalId: id, reason, runs: g && g.loop ? g.loop.runs : null });
    return true;
  }

  async _tick(id) {
    if (this._busy.has(id)) return; // no overlapping ticks
    const l = this._loops.get(id);
    if (!l) return;
    this._busy.add(id);
    try {
      const g = this.store.goals.get(id);
      if (!g || g.status !== 'active' || !g.loop) { this.stopLoop(id, 'goal_inactive'); return; }
      g.loop.runs += 1;
      const runs = g.loop.runs;
      const out = await this.takeStep(id);
      if (out.denied) { this.stopLoop(id, 'denied'); return; } // stop on deny
      if (out.done) { this.stopLoop(id, 'goal_done'); return; }
      if (runs >= g.loop.maxRuns) this.stopLoop(id, 'max_runs');
    } catch (e) {
      // A throwing tick must not kill the loop silently; record and stop.
      this._audit({ type: 'goal_loop_stopped', goalId: id, reason: 'tick_error', error: String((e && e.message) || e) });
      this.stopLoop(id, 'tick_error');
    } finally {
      this._busy.delete(id);
    }
  }

  loopState(id) {
    return { running: this._loops.has(id) };
  }

  stopAllLoops() {
    for (const id of [...this._loops.keys()]) this.stopLoop(id, 'shutdown');
  }

  // ── slash dispatcher ──
  // /goal add <text> | /goal status [id] | /goal pause|resume|clear <id>
  // /loop start <id> [everyMs] [maxRuns] | /loop stop <id>
  // /resume [id]  → resume (if paused) and replay the next pending step

  async slash(bot, cmd) {
    if (typeof cmd !== 'string' || !cmd.trim()) throw err('bad_request', 'cmd required');
    const trimmed = cmd.trim();
    if (!trimmed.startsWith('/')) throw err('bad_request', 'commands start with /');
    const parts = trimmed.split(/\s+/);
    const head = parts[0].toLowerCase();
    const rest = parts.slice(1);
    let out;
    try {
      out = await this._slashRun(bot, head, rest, trimmed);
      this._audit({ type: 'slash_run', bot: bot ? bot.name : null, cmd: trimmed.slice(0, 200), ok: true });
      return out;
    } catch (e) {
      this._audit({
        type: 'slash_run', bot: bot ? bot.name : null, cmd: trimmed.slice(0, 200),
        ok: false, error: String(e.message || e),
      });
      throw e;
    }
  }

  async _slashRun(bot, head, rest, full) {
    if (head === '/goal') {
      const sub = (rest[0] || '').toLowerCase();
      const arg = rest.slice(1);
      switch (sub) {
        case 'add': {
          const text = full.slice(full.indexOf('add') + 3).trim();
          if (!text) throw err('bad_request', 'usage: /goal add <text>');
          const g = this.add({ text, owner: bot.name, steps: [], bot });
          return { ok: true, message: `goal ${g.id} added (0 steps — add steps via POST /v2/goals/:id/step or on create)` };
        }
        case 'status': {
          if (arg[0]) {
            const g = this.get(arg[0]);
            return { ok: true, goal: this.project(g) };
          }
          return { ok: true, goals: this.list().map((g) => this.project(g)) };
        }
        case 'pause': {
          if (!arg[0]) throw err('bad_request', 'usage: /goal pause <id>');
          this.pause(arg[0], bot);
          return { ok: true, message: `goal ${arg[0]} paused` };
        }
        case 'resume': {
          if (!arg[0]) throw err('bad_request', 'usage: /goal resume <id>');
          this.resume(arg[0], bot);
          return { ok: true, message: `goal ${arg[0]} resumed` };
        }
        case 'clear': {
          if (!arg[0]) throw err('bad_request', 'usage: /goal clear <id>');
          this.clear(arg[0], bot);
          return { ok: true, message: `goal ${arg[0]} cleared` };
        }
        default:
          throw err('bad_request', 'usage: /goal add|status|pause|resume|clear');
      }
    }
    if (head === '/loop') {
      const sub = (rest[0] || '').toLowerCase();
      if (sub === 'start') {
        const [, id, everyMs, maxRuns] = rest;
        if (!id) throw err('bad_request', 'usage: /loop start <goalId> [everyMs] [maxRuns]');
        this.startLoop(id, {
          everyMs: everyMs ? Number(everyMs) : LOOP_DEFAULT_EVERY_MS,
          maxRuns: maxRuns ? Number(maxRuns) : LOOP_DEFAULT_MAX_RUNS,
        }, bot);
        return { ok: true, message: `loop started for ${id}` };
      }
      if (sub === 'stop') {
        const id = rest[1];
        if (!id) throw err('bad_request', 'usage: /loop stop <goalId>');
        const stopped = this.stopLoop(id, 'slash');
        return { ok: stopped, message: stopped ? `loop stopped for ${id}` : `no running loop for ${id}` };
      }
      throw err('bad_request', 'usage: /loop start|stop');
    }
    if (head === '/resume') {
      // Resume (if paused) and replay the next pending step of one goal.
      let g = null;
      if (rest[0]) {
        g = this.get(rest[0]);
        if (g.status === 'paused') this.resume(g.id, bot);
      } else {
        g = this.list().find((x) => x.status === 'paused') || this.list().find((x) => x.status === 'active');
        if (!g) throw err('not_found', 'no goal to resume');
        if (g.status === 'paused') this.resume(g.id, bot);
      }
      const out = await this.takeStep(g.id);
      const s = out.step;
      return {
        ok: true,
        message: out.done
          ? `goal ${g.id} has no pending steps (done)`
          : `goal ${g.id} step ${out.stepIndex} → ${s ? s.lastDecision : 'n/a'} (${s ? s.state : 'n/a'})`,
        result: { goalId: g.id, decision: out.verdict ? out.verdict.decision : 'none', approvalId: out.approvalId || null },
      };
    }
    throw err('bad_request', `unknown command ${head} (try /goal, /loop, /resume)`);
  }

  // ── projections ──

  projectStep(s) {
    return {
      tool: s.tool,
      state: s.state,
      attempts: s.attempts,
      lastDecision: s.lastDecision,
      approvalId: s.approvalId,
    }; // args intentionally omitted — never leak argument values
  }

  project(g) {
    return {
      id: g.id,
      text: g.text,
      status: g.status,
      owner: g.owner,
      steps: g.steps.map((s) => this.projectStep(s)),
      loop: g.loop ? { ...g.loop } : null,
      createdAt: g.createdAt,
      updatedAt: g.updatedAt,
    };
  }
}

// One engine per gateway instance (WeakMap, like chat-singleton).
const engines = new WeakMap();
function getEngine(gw) {
  let e = engines.get(gw);
  if (!e) {
    e = new GoalEngine({
      gw,
      file: process.env.TG_CONTINUITY_FILE || DEFAULT_FILE,
      now: gw.now,
    });
    engines.set(gw, e);
  }
  return e;
}

module.exports = {
  ContinuityStore,
  GoalEngine,
  getEngine,
  DEFAULT_FILE,
  GOAL_STATUSES,
  STEP_STATES,
  LOOP_DEFAULT_EVERY_MS,
  LOOP_DEFAULT_MAX_RUNS,
};
