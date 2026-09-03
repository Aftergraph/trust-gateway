'use strict';
// FS-G3 — multi-signal alarmering: AlertSink webhook delivery (§8(c)).
//
// Companion to telemetry.js (G12). Telemetry is in-band observability; the
// AlertSink is OUT-OF-BAND alarm delivery: when something is wrong (watchdog
// failure, restore refused) someone must be paged, not just logged.
//
// Rules:
//   - Targets: env TG_ALERT_URLS — comma-separated https URLs. Empty/unset →
//     the sink is a no-op (alert() returns false, zero fetches).
//   - Auth: env TG_ALERT_TOKEN — optional, sent as "Bearer <token>" on every
//     delivery. The token itself NEVER appears in a payload.
//   - Payload: { type, ts, host, fields } — fields projected to scalars
//     (string/number/boolean/null), same allow-list projection idea as
//     telemetry. Counts + types only: secrets never belong in alarms.
//   - Delivery: fetch POST, 3s timeout (AbortSignal.timeout), best-effort —
//     a failed webhook NEVER throws into the caller and NEVER rejects
//     unhandled. Return value is just a boolean (delivered?).
//   - Rate limit: at most one alert per TYPE per 60s window — further calls
//     in the window drop silently (same pattern as the telemetry ring).
//   - Suppression: max 5 deliveries per TYPE per rolling hour; after that the
//     type goes silent until an hour has passed since the 5th delivery.
//     Alert storms are a DoS vector on the receiver.
//   - Zero npm deps: global fetch (Node >= 18), injectable fetchImpl for tests.

const os = require('node:os');

const ALERT_RATE_LIMIT_MS = 60_000;   // max 1 per type per 60s
const ALERT_SUPPRESS_MAX = 5;         // max 5 per type per hour
const ALERT_SUPPRESS_MS = 3_600_000;  // rolling hour window for suppression
const ALERT_TIMEOUT_MS = 3_000;       // per-delivery timeout
const MAX_FIELD_STRING = 200;
const MAX_FIELDS = 16;

// Scalar allow-list projection (same spirit as telemetry.projectFields):
// keep only scalar own properties, truncate strings, cap the count.
function projectFields(fields) {
  if (fields === undefined || fields === null) return {};
  if (typeof fields !== 'object' || Array.isArray(fields)) return {}; // invalid → empty
  const out = {};
  let n = 0;
  for (const k of Object.keys(fields)) {
    if (n >= MAX_FIELDS) break;
    const v = fields[k];
    if (v === null) { out[k] = null; n++; continue; }
    const t = typeof v;
    if (t === 'string') { out[k] = v.length > MAX_FIELD_STRING ? v.slice(0, MAX_FIELD_STRING) : v; n++; continue; }
    if (t === 'number' && Number.isFinite(v)) { out[k] = v; n++; continue; }
    if (t === 'boolean') { out[k] = v; n++; continue; }
    // objects / arrays / functions: dropped — never leak structured secrets
  }
  return out;
}

// Parse TG_ALERT_URLS: comma-separated, whitespace-tolerant, empty pieces
// dropped. Returns [] for unset/empty (no-op sink).
function parseUrls(raw) {
  if (typeof raw !== 'string') return [];
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

class AlertSink {
  constructor({ urls, token, fetchImpl, now = () => Date.now(), host } = {}) {
    this.urls = Array.isArray(urls) ? urls : parseUrls(urls);
    this.token = typeof token === 'string' && token.length > 0 ? token : null;
    this.fetchImpl = fetchImpl || globalThis.fetch;
    this.now = now;
    this.host = host || os.hostname();
    this._lastByType = new Map();  // type -> last accepted delivery ts (rate limit)
    this._hourByType = new Map();  // type -> { hourStart, sent } rolling-hour budget
  }

  // Re-configure after construction (tests, mount-time env wiring). Passing
  // urls: null re-reads TG_ALERT_URLS / TG_ALERT_TOKEN from the given env.
  configure({ urls, token, fetchImpl, env = process.env } = {}) {
    if (fetchImpl) this.fetchImpl = fetchImpl;
    if (urls !== undefined) this.urls = Array.isArray(urls) ? urls : parseUrls(urls);
    if (token !== undefined) this.token = token;
    if (urls === null) {
      this.urls = parseUrls(env.TG_ALERT_URLS);
      this.token = typeof env.TG_ALERT_TOKEN === 'string' && env.TG_ALERT_TOKEN.length > 0 ? env.TG_ALERT_TOKEN : null;
    }
  }

  _withinBudget(type, ts) {
    const h = this._hourByType.get(type);
    if (!h) return true;
    if (ts - h.hourStart >= ALERT_SUPPRESS_MS) return true; // window rolled over
    return h.sent < ALERT_SUPPRESS_MAX;
  }

  _markBudget(type, ts) {
    const h = this._hourByType.get(type);
    if (!h || ts - h.hourStart >= ALERT_SUPPRESS_MS) {
      this._hourByType.set(type, { hourStart: ts, sent: 1 });
      return;
    }
    h.sent += 1;
  }

  // Returns true when at least one delivery was accepted, false when dropped
  // (no URLs, rate-limited, suppressed, invalid type) or when every target
  // failed. NEVER throws.
  async alert(type, fields = {}) {
    try {
      if (typeof type !== 'string' || type.length === 0) return false;
      if (!this.urls || this.urls.length === 0) return false;
      const ts = this.now();

      // rate limit: max 1 per type per 60s (silent drop, like telemetry ring)
      const last = this._lastByType.get(type);
      if (last !== undefined && ts - last < ALERT_RATE_LIMIT_MS) return false;

      // suppression: max 5 per type per rolling hour, then silent
      if (!this._withinBudget(type, ts)) return false;

      const payload = JSON.stringify({
        type,
        ts,
        host: this.host,
        fields: projectFields(fields),
      });
      const headers = { 'content-type': 'application/json' };
      if (this.token) headers.authorization = `Bearer ${this.token}`;

      let delivered = 0;
      const results = await Promise.allSettled(this.urls.map((url) =>
        Promise.race([
          Promise.resolve().then(() => this.fetchImpl(url, {
            method: 'POST',
            headers,
            body: payload,
            signal: AbortSignal.timeout(ALERT_TIMEOUT_MS),
          })),
          new Promise((_, reject) =>
            setTimeout(() => reject(new Error('alert_timeout')), ALERT_TIMEOUT_MS + 100)),
        ])));
      for (const r of results) {
        if (r.status === 'fulfilled') delivered += 1;
      }
      if (delivered === 0) return false;

      this._lastByType.set(type, ts); // only advance the window when something went out
      this._markBudget(type, ts);
      return true;
    } catch {
      return false; // best-effort: alarmering must never break the caller
    }
  }
}

// Per-gateway module-level sink — usable from mounts without touching
// server.js (server.js edits are forbidden for FS-G3). Cached per gw via a
// WeakMap so repeated getAlertSink(gw) calls return the same instance.
const _sinks = new WeakMap();

function getAlertSink(gw) {
  let sink = _sinks.get(gw);
  if (!sink) {
    sink = new AlertSink({ urls: parseUrls(process.env.TG_ALERT_URLS) });
    if (typeof process.env.TG_ALERT_TOKEN === 'string' && process.env.TG_ALERT_TOKEN.length > 0) {
      sink.token = process.env.TG_ALERT_TOKEN;
    }
    if (gw && typeof gw.now === 'function') {
      sink.now = gw.now; // use the gateway's clock if it exposes one
    }
    _sinks.set(gw, sink);
  }
  return sink;
}

module.exports = {
  AlertSink,
  getAlertSink,
  parseUrls,
  projectFields,
  ALERT_RATE_LIMIT_MS,
  ALERT_SUPPRESS_MAX,
  ALERT_SUPPRESS_MS,
  ALERT_TIMEOUT_MS,
};