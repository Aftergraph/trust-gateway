'use strict';
// W6 — provider/model registry + free-tier-first routing plan.
//
// providers.json (data/providers.json, atomic tmp+rename, 0600, fail closed
// on corrupt — approvals.js pattern) seeds the REAL provider set:
//   dialagram, ollama-cloud, openrouter, opencode-zen, opencode-go,
//   anthropic, openai
// with kind + model lists. dialagram's list mirrors config.yaml
// (providers.dialagram.models). NEVER any key/token material here — the
// registry stores names, base URLs and model ids only; keys live in the
// operator's env/credential store and are out of scope for this module.
//
// plan({task, preferFree}) is a pure heuristic (no network): free lanes
// first when preferFree. Lanes mirror live operator knowledge (2026-09-02):
//   - OpenRouter paid lanes: no credits (exhausted)
//   - OpenCode Go: monthly usage limit reached (rate-limited, resets ~19d)
//   - Free lanes: ollama-cloud glm-5.3-flash, minimax-m3:free (OpenRouter),
//     laguna-s-2.1-free (OpenCode Zen)

const fs = require('node:fs');
const path = require('node:path');

// ── seed: the real provider set ───────────────────────────────────────
// kinds: 'aggregator' (routes many models), 'direct' (first-party API),
// 'proxy' (self-hosted router in front of other providers).
const SEED = [
  {
    name: 'dialagram',
    kind: 'proxy',
    baseUrl: 'https://dialagram.me/router/v1',
    // Mirrors config.yaml providers.dialagram.models exactly.
    models: [
      'deepseek-v4',
      'meta-muse-spark-1.2',
      'nexum-router',
      'qwen-3.5-omni-plus',
      'qwen-3.5-plus',
      'qwen-3.5-plus-thinking',
      'qwen-3.6-max-preview',
      'qwen-3.6-max-preview-thinking',
      'qwen-3.6-plus',
      'qwen-3.6-plus-thinking',
      'qwen-3.7-max',
      'qwen-3.7-max-thinking',
      'qwen-3.7-plus',
      'qwen-3.7-plus-thinking',
      'qwen-3.8-max-thinking',
      'tencent-hy3',
      'xiaomi-mimo-2.5',
    ],
    defaultModel: 'qwen-3.7-max',
  },
  {
    name: 'ollama-cloud',
    kind: 'aggregator',
    baseUrl: 'https://ollama.com/v1',
    models: ['glm-5.3-flash', 'deepseek-v4-flash', 'minimax-m2.7', 'kimi-k2.7-code', 'glm-5.2'],
    defaultModel: 'glm-5.3-flash',
  },
  {
    name: 'openrouter',
    kind: 'aggregator',
    baseUrl: 'https://openrouter.ai/api/v1',
    models: ['minimax/minimax-m3:free', 'z-ai/glm-5.2:free', 'deepseek/deepseek-v4:free'],
    defaultModel: 'minimax/minimax-m3:free',
  },
  {
    name: 'opencode-zen',
    kind: 'aggregator',
    baseUrl: 'https://opencode.ai/zen/v1',
    models: ['laguna-s-2.1-free', 'grok-code-2'],
    defaultModel: 'laguna-s-2.1-free',
  },
  {
    name: 'opencode-go',
    kind: 'aggregator',
    baseUrl: 'https://opencode.ai/zen/go/v1',
    models: ['claude-sonnet-5-go', 'gpt-5.4-go'],
    defaultModel: 'claude-sonnet-5-go',
  },
  {
    name: 'anthropic',
    kind: 'direct',
    baseUrl: 'https://dialagram.me/router/claude',
    models: ['claude-sonnet-5', 'claude-opus-5'],
    defaultModel: 'claude-sonnet-5',
  },
  {
    name: 'openai',
    kind: 'direct',
    baseUrl: 'https://api.openai.com/v1',
    models: ['gpt-5.4', 'gpt-5.4-mini'],
    defaultModel: 'gpt-5.4',
  },
];

// Free-tier-first lane order (operator knowledge, 2026-09-02):
// OpenRouter PAID exhausted, OpenCode Go rate-limited (resets in ~19d).
// Free lanes: ollama-cloud glm-5.3-flash, minimax-m3:free (OpenRouter),
// laguna-s-2.1-free (OpenCode Zen). Non-free lanes rank last.
const FREE_LANES = [
  { provider: 'ollama-cloud', model: 'glm-5.3-flash', reason: 'free_lane' },
  { provider: 'openrouter', model: 'minimax/minimax-m3:free', reason: 'free_lane' },
  { provider: 'opencode-zen', model: 'laguna-s-2.1-free', reason: 'free_lane' },
];

// Known constraint state mirrored from the operator's live provider pool.
const LANE_NOTES = {
  openrouter: 'paid lanes exhausted (no credits) — free lanes only',
  'opencode-go': 'monthly usage limit reached — rate-limited, resets in ~19d',
};

// Cheap keyword buckets — used ONLY for the `task` hint, never for policy.
const TASK_HINTS = [
  { re: /code|refactor|implement|bug|debug|test/i, tag: 'code' },
  { re: /summar|translate|write|draft|email|blog|copy/i, tag: 'text' },
  { re: /reason|math|plan|analy[sz]e|logic/i, tag: 'reasoning' },
];

class ProviderRegistry {
  constructor({ file = null, now = () => Date.now() } = {}) {
    this.file = file;
    this.now = now;
    this.providers = new Map(); // name -> record
    this.planHistory = [];      // last N plans (audited payloads, no secrets)
    if (file && fs.existsSync(file)) this._load();
    for (const p of SEED) {
      if (!this.providers.has(p.name)) {
        this.providers.set(p.name, {
          name: p.name,
          kind: p.kind,
          baseUrl: p.baseUrl,
          models: p.models.slice(),
          defaultModel: p.defaultModel,
          status: 'unknown', // unknown | ok | unreachable — set only by liveProbe
          lastProbeAt: null,
          seededAt: this.now(),
        });
      }
    }
  }

  // ── persistence (fail closed) ─────────────────────────────────────
  _load() {
    let raw;
    try {
      raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
    } catch {
      throw new Error('providers: file unparseable — refusing to load (fail closed)');
    }
    if (!raw || typeof raw !== 'object' || !Array.isArray(raw.providers)) {
      throw new Error('providers: file must be {providers: [...]} — refusing to load (fail closed)');
    }
    for (const p of raw.providers) {
      if (!p || typeof p.name !== 'string' || p.name.length === 0) {
        throw new Error('providers: entry missing name — refusing to load (fail closed)');
      }
      this.providers.set(p.name, {
        name: p.name,
        kind: p.kind || 'direct',
        baseUrl: p.baseUrl || null,
        models: Array.isArray(p.models) ? p.models.slice() : [],
        defaultModel: p.defaultModel || null,
        status: p.status || 'unknown',
        lastProbeAt: p.lastProbeAt || null,
        seededAt: p.seededAt || this.now(),
      });
    }
    // Seed models merge into existing entries so a stale file still gains
    // new models on upgrade (SEED is the source of truth for the set).
    for (const p of SEED) {
      const cur = this.providers.get(p.name);
      if (!cur) continue;
      const merged = new Set(cur.models);
      for (const m of p.models) merged.add(m);
      cur.models = [...merged];
      if (!cur.defaultModel) cur.defaultModel = p.defaultModel;
    }
  }

  _save() {
    if (!this.file) return;
    const rows = [...this.providers.values()].map((p) => ({
      name: p.name,
      kind: p.kind,
      baseUrl: p.baseUrl,
      models: p.models.slice(),
      defaultModel: p.defaultModel,
      status: p.status,
      lastProbeAt: p.lastProbeAt,
      seededAt: p.seededAt,
    }));
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = this.file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify({ providers: rows, savedAt: this.now() }, null, 2) + '\n');
    fs.renameSync(tmp, this.file);
    try { fs.chmodSync(this.file, 0o600); } catch { /* best effort */ }
  }

  // ── projections (never any key material) ──────────────────────────
  list() {
    return [...this.providers.values()].map((p) => ({
      name: p.name,
      kind: p.kind,
      baseUrl: p.baseUrl,
      modelCount: p.models.length,
      defaultModel: p.defaultModel,
      status: p.status,
      lastProbeAt: p.lastProbeAt,
    }));
  }

  get(name) {
    return this.providers.get(String(name || '')) || null;
  }

  // Flat model catalog across all providers.
  models() {
    const out = [];
    for (const p of this.providers.values()) {
      for (const m of p.models) {
        out.push({
          provider: p.name,
          kind: p.kind,
          model: m,
          isDefault: m === p.defaultModel,
        });
      }
    }
    return out;
  }

  // ── plan: free-tier-first heuristic (pure, no network, no secrets) ──
  plan({ task = '', preferFree = false, maxLanes = 5 } = {}) {
    if (typeof task !== 'string') task = String(task ?? '');
    const taskTag = TASK_HINTS.find((h) => h.re.test(task))?.tag || 'general';

    // Rank every (provider, model) lane:
    //   0 free-lane, 1 other free-ish (unknown billing), 2 paid lane.
    const laneRank = (provName, model) => {
      if (FREE_LANES.some((l) => l.provider === provName && l.model === model)) return 0;
      if (/:free$/.test(model)) return 1;
      return 2;
    };

    const lanes = [];
    for (const p of this.providers.values()) {
      for (const m of p.models) {
        const rank = laneRank(p.name, m);
        lanes.push({
          provider: p.name,
          model: m,
          free: rank === 0 || rank === 1,
          rank,
          note: LANE_NOTES[p.name] || null,
        });
      }
    }

    // preferFree: free lanes strictly first, else only a gentle nudge —
    // paid lanes stay available but demoted (rank + 1 penalty).
    const laneIdx = (l) => {
      const i = FREE_LANES.findIndex((f) => f.provider === l.provider && f.model === l.model);
      return i === -1 ? 99 : i;
    };
    const score = (l) => (preferFree ? l.rank : l.rank + (l.free ? -0.5 : 0));
    lanes.sort((a, b) =>
      score(a) - score(b) ||
      laneIdx(a) - laneIdx(b) ||      // mirrored free-lane order within a rank
      (a.provider === 'dialagram' ? -1 : b.provider === 'dialagram' ? 1 : 0) ||
      a.provider.localeCompare(b.provider) ||
      a.model.localeCompare(b.model)
    );

    const picked = lanes.slice(0, Math.max(1, maxLanes));
    const primary = picked[0];
    const out = {
      taskTag,
      preferFree: Boolean(preferFree),
      primary: { provider: primary.provider, model: primary.model },
      fallbacks: picked.slice(1).map((l) => ({ provider: l.provider, model: l.model })),
      lanes: picked,
      generatedAt: this.now(),
    };
    // Every emitted lane must exist in the registry — self-check (test
    // re-asserts this against the independent models() projection).
    for (const l of picked) {
      const p = this.providers.get(l.provider);
      if (!p || !p.models.includes(l.model)) throw new Error(`plan emitted unknown lane ${l.provider}/${l.model}`);
    }
    this.planHistory.push({ taskTag, preferFree: out.preferFree, primary: out.primary });
    if (this.planHistory.length > 100) this.planHistory.shift();
    this._save();
    return out;
  }

  // ── liveProbe: OPTIONAL, non-blocking, best effort. Never throws. ──
  // GET {baseUrl}/models with a short timeout; sets status ok|unreachable.
  // Never sends any key; never called by the mount unless ?probe is set.
  async liveProbe(name, { timeoutMs = 2500 } = {}) {
    const p = this.get(name);
    if (!p || !p.baseUrl) return { ok: false, provider: name, error: 'unknown_provider' };
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(`${p.baseUrl}/models`, { signal: ctrl.signal });
      p.status = res.ok ? 'ok' : 'unreachable';
    } catch {
      p.status = 'unreachable';
    } finally {
      clearTimeout(t);
    }
    p.lastProbeAt = this.now();
    this._save();
    return { provider: p.name, status: p.status, ok: p.status === 'ok' };
  }
}

module.exports = { ProviderRegistry, SEED, FREE_LANES, LANE_NOTES };