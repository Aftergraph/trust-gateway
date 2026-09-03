'use strict';
// Trust Gateway — post-launch telemetry (§20.4, G12).
//
// Observability ≠ governance: telemetry events are NOT sealed into the audit
// chain (no gw._audit, no hash, no /v1/audit surface). They land in a bounded
// in-memory ring buffer mirrored to data/telemetry.json (atomic tmp+rename,
// mode 0600 — same pattern as approvals.js / agent-store.js / memory.js) so
// the last 2000 events survive a restart. Corruption is fail-open: telemetry
// is best-effort observability, never a reason to refuse boot.
//
// Rules:
//   - Allow-list: only the §20.4 event names below can be recorded. Unknown
//     events are rejected by the mount (400) and by record() (returns false).
//   - Per-type rate limit: at most one record per type per 250 ms window —
//     further calls in the window drop SILENTLY (no error, no audit noise).
//   - Scalar projection: fields are projected to an allow-list of scalar
//     values (string/number/boolean/null) — never objects, arrays, or free
//     text blobs. Strings are truncated. Tokens never belong here.
//   - Ring: max 2000 entries, FIFO (oldest evicted first).

const fs = require('node:fs');
const path = require('node:path');

// §20.4 catalog (docs/ux/05-SYSTEM.md). Deliberately EXCLUDES plugin_*/ and
// adapter_kind_* — those are governance events and are already audited (see
// TRANSPARENCY.md rows for plugins.js / 99-adapter-kinds.js).
const CATALOG = [
  { type: 'palette_open', description: 'palette opened (once per browser session)' },
  { type: 'palette_command', description: 'palette command submitted' },
  { type: 'palette_search', description: 'palette search executed (qlen, result count)' },
  { type: 'palette_object_resolve', description: 'object resolved via seq/token/search (+success)' },
  { type: 'palette_nl_intent', description: 'natural-language fallback to planner' },
  { type: 'panel_manifest_validate', description: 'manifest validation result' },
  { type: 'capability_filter_hit', description: 'capability filter allowed/denied a surface' },
  { type: 'compose_engine_render', description: 'composition engine render (latency, domain, surfaces)' },
  { type: 'migration_phase', description: 'migration phase transition (phase, hasFlag)' },
  { type: 'four_oh2_handled', description: '402/429 handled and recovered (renamed from 402_429_handled — extractor-hostile)' },
  { type: 'tg_api_raw_fetch_blocked', description: 'raw fetch with operator token blocked (§19.2)' },
  { type: 'tg_session_unavailable', description: 'capability-scoped session unavailable (§19.2)' },
  { type: 'search_backend_fts5_swap', description: 'search backend substring→FTS5 transition' },
];

const ALLOWED = new Set(CATALOG.map((e) => e.type));

const MAX_EVENTS = 2000;
const RATE_LIMIT_MS = 250;
const MAX_FIELD_STRING = 200;
const MAX_FIELDS = 16;

const DEFAULT_FILE = path.resolve(__dirname, '..', '..', 'data', 'telemetry.json');

// Scalar allow-list projection: keep only scalar-valued own properties.
function projectFields(fields) {
  if (fields === undefined || fields === null) return {};
  if (typeof fields !== 'object' || Array.isArray(fields)) return null; // invalid
  const out = {};
  let n = 0;
  for (const k of Object.keys(fields)) {
    if (n >= MAX_FIELDS) break;
    const v = fields[k];
    const t = typeof v;
    if (v === null) { out[k] = null; n++; continue; }
    if (t === 'string') { out[k] = v.length > MAX_FIELD_STRING ? v.slice(0, MAX_FIELD_STRING) : v; n++; continue; }
    if (t === 'number' && Number.isFinite(v)) { out[k] = v; n++; continue; }
    if (t === 'boolean') { out[k] = v; n++; continue; }
    // objects / arrays / functions / symbols: dropped by projection
  }
  return out;
}

class TelemetryRing {
  constructor({ file = DEFAULT_FILE, max = MAX_EVENTS, now = () => Date.now() } = {}) {
    this.file = file;
    this.max = max;
    this.now = now;
    this.events = [];
    this._lastByType = new Map(); // type -> last accepted ts (rate limit)
    this._load();
  }

  _load() {
    if (!this.file || !fs.existsSync(this.file)) return;
    let data;
    try {
      data = JSON.parse(fs.readFileSync(this.file, 'utf8'));
    } catch {
      this.events = []; // fail-open: observability, not governance
      return;
    }
    const rows = data && Array.isArray(data.events) ? data.events : [];
    this.events = rows
      .filter((e) => e && ALLOWED.has(e.type) && typeof e.ts === 'number' &&
        (e.fields === undefined || (typeof e.fields === 'object' && !Array.isArray(e.fields))))
      .slice(-this.max);
  }

  _save() {
    if (!this.file) return;
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const tmp = this.file + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify({ version: 1, events: this.events }, null, 2) + '\n');
      fs.renameSync(tmp, this.file);
      try { fs.chmodSync(this.file, 0o600); } catch { /* best effort */ }
    } catch { /* best effort — telemetry must never break the request path */ }
  }

  // Returns true when recorded, false when dropped (unknown type, rate-limited,
  // or invalid fields). NEVER throws, NEVER touches the audit chain.
  record(event, fields) {
    if (!ALLOWED.has(event)) return false;
    const projected = projectFields(fields);
    if (projected === null) return false;
    const ts = this.now();
    const last = this._lastByType.get(event);
    if (last !== undefined && ts - last < RATE_LIMIT_MS) return false; // silent drop
    this._lastByType.set(event, ts);
    this.events.push({ type: event, ts, fields: projected });
    if (this.events.length > this.max) this.events.splice(0, this.events.length - this.max);
    this._save();
    return true;
  }

  query({ event = null, since = 0 } = {}) {
    return this.events.filter((e) =>
      (event === null || e.type === event) && e.ts >= since);
  }

  get size() { return this.events.length; }
}

module.exports = { TelemetryRing, CATALOG, ALLOWED, projectFields, DEFAULT_FILE, MAX_EVENTS, RATE_LIMIT_MS };
