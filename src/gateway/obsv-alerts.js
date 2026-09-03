'use strict';
// FS-I2 — observability → AlertSink coupling: auto-alerts from snapshot().
//
// Companion to obsv.js (FS-G2, in-band snapshot) and alerting.js (FS-G3,
// out-of-band AlertSink webhook delivery). Every observability snapshot now
// evaluates TWO degradation conditions and pages the operator through the
// SAME sink the watchdog uses — one delivery path, one rate limit, one
// suppression budget:
//
//   - ratelimit_spike: apikeys.rateLimitedLast1h > TG_ALERT_RATELIMIT_THRESHOLD
//     (default 10). Someone is hammering a rate-limited key; the operator
//     sees counts only ({count, threshold}), never key material.
//   - chain_stall: chain.length unchanged since the last snapshot AND
//     uptimeSec > TG_ALERT_CHAIN_STALL_SEC (default 300). The tamper-evident
//     audit chain has stopped growing — either the gateway is idle (harmless)
//     or the chain writer is stuck (serious). Payload is {head, stalledSince}:
//     the head hash and an ISO timestamp, nothing else.
//
// Rules:
//   - Thresholds are env-configurable and re-read per evaluation (tests and
//     operators can retune without a restart).
//   - Last-seen chain length persists in kv_store key 'obsv:lastChainLen'
//     (via kvstore.js), so a gateway restart does not reset stall tracking
//     to "changed" (which would mask a stall that predates the restart).
//   - INERT BY DEFAULT: with TG_ALERT_URLS unset the AlertSink has no
//     targets, so evaluateAlerts short-circuits BEFORE any side effect —
//     no fetch, no kv write. Observability stays a pure read.
//   - Fail-open: a broken db/kv or sink never throws into snapshot(); the
//     snapshot body is returned untouched either way.
//   - Zero npm deps; alert() is async (fetch) but snapshot() stays sync —
//     obsv.js fires evaluation without awaiting it.

const { KV } = require('./kvstore');
const { getAlertSink } = require('./alerting');

const CHAIN_LEN_KEY = 'obsv:lastChainLen';
const DEFAULT_RATELIMIT_THRESHOLD = 10;
const DEFAULT_CHAIN_STALL_SEC = 300;

// WeakMap token so this module gets its own stable sink instance from
// alerting.getAlertSink without inventing a second delivery path.
const SINK_TOKEN = { component: 'obsv-alerts' };

// Cached KV handle (lazy: never opens a db at require time).
let _kv = null;
let _kvFailed = false;

function getKv() {
  if (_kvFailed) return null;
  if (!_kv) {
    try {
      _kv = new KV();
    } catch {
      _kvFailed = true;
      return null;
    }
  }
  return _kv;
}

/** Env threshold with a safe default; negative/garbage values fall back. */
function envThreshold(env, name, dflt) {
  const raw = env[name];
  if (raw === undefined || raw === null || raw === '') return dflt;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : dflt;
}

// Single emit shape so the audit type literals are visible to the
// standards extraction (tests/standards.test.js) exactly as documented.
async function emit(sink, def) {
  return sink.alert(def.type, def.fields);
}

/**
 * Evaluate auto-alert conditions against one snapshot. NEVER throws.
 *
 * @param {object} snap — the obsv.snapshot(gw) result (read-only here).
 * @param {object} [opts] — test seams: { sink, kv, env, now }.
 * @returns {Promise<{ratelimit: boolean, stall: boolean}>} whether each
 *   alert was ACCEPTED by the sink (false when inert/rate-limited/failing).
 */
async function evaluateAlerts(snap, opts = {}) {
  const out = { ratelimit: false, stall: false };
  try {
    if (!snap || typeof snap !== 'object') return out;
    const env = opts.env || process.env;
    const now = opts.now || Date.now;
    const sink = opts.sink || getAlertSink(SINK_TOKEN);

    // Inert by default: no TG_ALERT_URLS → zero side effects, zero fetches.
    if (!sink || !Array.isArray(sink.urls) || sink.urls.length === 0) return out;

    const kv = opts.kv || getKv();

    // ── condition 1: rate-limit spike ────────────────────────────────────
    const rlThreshold = envThreshold(env, 'TG_ALERT_RATELIMIT_THRESHOLD', DEFAULT_RATELIMIT_THRESHOLD);
    const limited = snap.apikeys && Number.isFinite(snap.apikeys.rateLimitedLast1h)
      ? snap.apikeys.rateLimitedLast1h
      : 0;
    if (limited > rlThreshold) {
      out.ratelimit = await emit(sink, {
        type: 'obsv_alert_ratelimit_spike',
        fields: { count: limited, threshold: rlThreshold },
      });
    }

    // ── condition 2: chain stall ─────────────────────────────────────────
    const stallSec = envThreshold(env, 'TG_ALERT_CHAIN_STALL_SEC', DEFAULT_CHAIN_STALL_SEC);
    // length 0 is the fail-open shape from chainSection() (verify threw /
    // nothing yet) — never treat it as a real stalled length.
    const len = snap.chain && Number.isFinite(snap.chain.length) && snap.chain.length > 0
      ? snap.chain.length
      : null;
    if (len !== null && kv) {
      const last = kv.get(CHAIN_LEN_KEY);
      const lastLen = typeof last === 'number' && Number.isFinite(last) ? last : null;
      const changed = lastLen === null || lastLen !== len;
      if (changed) {
        kv.set(CHAIN_LEN_KEY, len); // persist last-seen length across calls/restarts
      } else if (typeof snap.uptimeSec === 'number' && snap.uptimeSec > stallSec) {
        const stalledSince = opts.stalledSince || new Date(now() - (snap.uptimeSec * 1000)).toISOString();
        out.stall = await emit(sink, {
          type: 'obsv_alert_chain_stall',
          fields: { head: snap.chain.head, stalledSince },
        });
      }
    }
    return out;
  } catch {
    return out; // fail-open: alerting must never break the snapshot
  }
}

/** Test seam: drop the cached KV handle so the next call re-opens it. */
function _resetForTests() {
  _kv = null;
  _kvFailed = false;
}

module.exports = {
  evaluateAlerts,
  envThreshold,
  CHAIN_LEN_KEY,
  DEFAULT_RATELIMIT_THRESHOLD,
  DEFAULT_CHAIN_STALL_SEC,
  _resetForTests,
};
