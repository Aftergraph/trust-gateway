'use strict';
// Router v0.2 — telemetry-driven fallback-learning.
//
// Rolling-window outcome ledger per (provider, model). The router reads this to
// demote providers whose recent outcomes are failing — learning from telemetry,
// not from static config. Storage: JSON file (tmp+rename, mode 0600, fail-closed
// on corrupt — same law as approvals/memory).
//
// ponytail: naive score = successes/(successes+failures) over the window; upgrade
// path = EWMA per latency bucket once there's enough volume to matter.

const fs = require('node:fs');
const path = require('node:path');

const WINDOW_MS = 30 * 60 * 1000; // 30 minutes of recent outcomes
const WINDOW = WINDOW_MS;
const MAX_EVENTS = 500;

class RouterTelemetry {
  constructor({ file = null, now = () => Date.now() } = {}) {
    this.file = file;
    this.now = now;
    this.events = []; // {provider, model, ok, latency_ms, ts}
    this._load();
  }

  _load() {
    if (!this.file || !fs.existsSync(this.file)) return;
    let data;
    try {
      data = JSON.parse(fs.readFileSync(this.file, 'utf8'));
    } catch {
      throw new Error('routerTelemetry: file unparseable — refusing to load (fail closed)');
    }
    if (!Array.isArray(data.events)) throw new Error('routerTelemetry: file must hold an events array');
    this.events = data.events.slice(-MAX_EVENTS);
  }

  _save() {
    if (!this.file) return;
    const tmp = this.file + '.tmp';
    const fd = fs.openSync(tmp, 'w', 0o600);
    try {
      fs.writeFileSync(fd, JSON.stringify({ events: this.events }));
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(tmp, this.file);
  }

  /** Record one route outcome. */
  record({ provider, model, ok, latency_ms = null }) {
    if (!provider || !model) throw new Error('routerTelemetry: provider+model required');
    const ev = {
      provider: String(provider),
      model: String(model),
      ok: !!ok,
      latency_ms: latency_ms == null ? null : Number(latency_ms),
      ts: this.now(),
    };
    this.events.push(ev);
    // prune: window + cap
    const cutoff = this.now() - WINDOW;
    this.events = this.events.filter((e) => e.ts >= cutoff).slice(-MAX_EVENTS);
    this._save();
    return ev;
  }

  /** Health score per provider over the window: 1.0 = all success, 0 = all fail. */
  health() {
    const byProvider = {};
    for (const e of this.events) {
      const b = (byProvider[e.provider] ||= { ok: 0, fail: 0 });
      if (e.ok) b.ok++; else b.fail++;
    }
    const scores = {};
    for (const [p, { ok, fail }] of Object.entries(byProvider)) {
      scores[p] = { score: ok / (ok + fail), ok, fail };
    }
    return { window_ms: WINDOW, scores };
  }

  /**
   * Demote fallback list entries whose provider health < threshold (default 0.5).
   * Returns the reordered fallback list — the router re-reads this before responding.
   */
  reorderFallbacks(fallbacks, { threshold = 0.5 } = {}) {
    const { scores } = this.health();
    const score = (provider) => (scores[provider] ? scores[provider].score : 1); // unknown = neutral
    return [...fallbacks].sort((a, b) => score(b.provider) - score(a.provider))
      .filter((f) => score(f.provider) >= threshold || scores[f.provider] === undefined)
      .concat(fallbacks.filter((f) => score(f.provider) < threshold));
  }

  /** Providers currently failing hard (score 0 with >=3 samples) — the router avoids them. */
  blacklisted({ minSamples = 3 } = {}) {
    const { scores } = this.health();
    return Object.entries(scores)
      .filter(([, s]) => s.ok + s.fail >= minSamples && s.score === 0)
      .map(([p]) => p);
  }
}

module.exports = { RouterTelemetry, WINDOW_MS };