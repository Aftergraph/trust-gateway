'use strict';
// FS-I4 — audit-log export: webhook + S3 stub, operator-gated, backpressure.
//
// Companion to events.js (SSE fan-out) and alerting.js (FS-G3 out-of-band
// alarms). The audit chain remains the single source of truth; this module
// STREAMS sealed entries to operator-configured external sinks:
//
//   - Webhook sink:  env TG_AUDIT_EXPORT_WEBHOOK (URL). Every sealed audit
//     entry is POSTed as JSON with a 3 s timeout, rate-limited to 10 sends
//     per second per sink. Backpressure: 3 failures inside a rolling 60 s
//     window → the sink is suppressed for 5 minutes and an
//     `audit_export_backoff` row explains why (storm = DoS vector on the
//     receiver, same reasoning as alerting.js suppression).
//   - S3 stub sink:  env TG_AUDIT_EXPORT_S3_BUCKET (+ TG_AUDIT_EXPORT_S3_REGION,
//     default us-east-1). ZERO AWS SDK (zero-dep rule) — the stub appends the
//     entry to a local JSONL fallback at
//     data/audit-export/<tenant>/<date>.jsonl and seals an
//     `s3_upload_pending {bucket, key}` audit row naming the would-be S3
//     object. A one-time `audit_export_s3_stub {bucket, region}` row records
//     that stub mode (not real S3) is in effect.
//
// Rules honored here:
//   - Both sinks are INERT unless their env is set — env-off behavior is
//     byte-identical to the pre-FS-I4 gateway (no fetches, no files, no
//     extra audit rows, chain untouched).
//   - emit() is fire-and-forget from the audit append path (wired in
//     events.js): a slow, hanging or failing sink NEVER blocks or breaks
//     the audit append, and never rejects unhandled.
//   - The module's own audit rows (audit_export_*, s3_upload_pending) are
//     never re-exported (re-entrancy guard) — no infinite loop through the
//     'audit' event.
//   - Zero npm deps: global fetch (Node >= 18), injectable fetchImpl/now/env
//     for tests.
//   - Payload hygiene: entries are forwarded as sealed — this module adds
//     nothing to them; its own rows carry bucket/key/error metadata only,
//     never entry contents.

const fs = require('node:fs');
const path = require('node:path');

const WEBHOOK_TIMEOUT_MS = 3_000;    // per-delivery timeout
const WEBHOOK_RATE_LIMIT = 10;       // max sends per rolling 1 s window
const WEBHOOK_RATE_WINDOW_MS = 1_000;
const BACKOFF_FAILURES = 3;          // failures ...
const BACKOFF_WINDOW_MS = 60_000;    // ... within this window ...
const BACKOFF_SUPPRESS_MS = 300_000; // ... → suppressed for 5 minutes
const MAX_ERROR_LEN = 120;

class ExportSink {
  constructor(gw, opts = {}) {
    this.gw = gw || null;
    const env = opts.env || process.env;
    this.webhookUrl = trimOrNull(env.TG_AUDIT_EXPORT_WEBHOOK);
    this.bucket = trimOrNull(env.TG_AUDIT_EXPORT_S3_BUCKET);
    this.region = trimOrNull(env.TG_AUDIT_EXPORT_S3_REGION) || 'us-east-1';
    this.fetchImpl = opts.fetchImpl || globalThis.fetch;
    this.now = opts.now
      || (gw && typeof gw.now === 'function' ? () => gw.now() : () => Date.now());
    this.timeoutMs = opts.timeoutMs || WEBHOOK_TIMEOUT_MS;
    // Local fallback root for the S3 stub (env override for tests / deploy).
    this.dataDir = opts.dataDir
      || trimOrNull(env.TG_AUDIT_EXPORT_DIR)
      || path.join(process.cwd(), 'data', 'audit-export');
    this._sendTimes = [];     // webhook send timestamps (rate limit window)
    this._failures = [];      // webhook failure timestamps (backoff window)
    this._suppressUntil = 0;  // epoch ms while backed off
    this.lastError = null;    // last webhook error string (surfaced by test endpoint)
    this._s3Announced = false; // one-time audit_export_s3_stub row
  }

  get webhookConfigured() { return this.webhookUrl !== null; }
  get s3Configured() { return this.bucket !== null; }
  get inert() { return !this.webhookConfigured && !this.s3Configured; }

  /**
   * Stream one sealed audit entry to the configured sinks. Never throws;
   * resolves to { webhookOk, s3StubOk, lastError } for callers that await
   * it (the audit append path does NOT await).
   */
  async emit(entry) {
    const out = { webhookOk: false, s3StubOk: false, lastError: null };
    try {
      if (!entry || typeof entry !== 'object') return out;
      // Re-entrancy guard: never re-export the module's own audit rows.
      const t = entry.payload && entry.payload.type;
      if (typeof t === 'string'
        && (t.startsWith('audit_export_') || t === 's3_upload_pending')) {
        return out;
      }
      if (this.webhookConfigured) {
        const r = await this._deliverWebhook(entry);
        out.webhookOk = r.ok;
        if (!r.ok && r.error) out.lastError = r.error;
      }
      if (this.s3Configured) {
        try {
          this._writeS3Stub(entry);
          out.s3StubOk = true;
        } catch (e) {
          out.lastError = out.lastError || errStr(e);
        }
      }
      out.lastError = this.lastError;
    } catch (e) {
      out.lastError = errStr(e); // absolute best-effort
    }
    return out;
  }

  /**
   * Operator-triggered self-test (POST /v2/audit/export/test): sends one
   * synthetic entry to each configured sink and reports the outcome. The
   * webhook probe bypasses an active backoff so an operator gets a TRUE
   * answer, not a cached "suppressed".
   */
  async testDelivery() {
    const out = { webhookOk: false, s3StubOk: false, lastError: this.lastError };
    if (this.inert) { out.inert = true; return out; }
    const entry = {
      seq: 0,
      ts: this.now(),
      hash: null,
      payload: { type: 'audit_export_test', synthetic: true, note: 'operator-triggered export self-test' },
    };
    if (this.webhookConfigured) {
      const r = await this._deliverWebhook(entry, { bypassBackoff: true });
      out.webhookOk = r.ok;
      if (!r.ok && r.error) out.lastError = r.error;
    }
    if (this.s3Configured) {
      try {
        this._writeS3Stub(entry);
        out.s3StubOk = true;
      } catch (e) {
        out.lastError = errStr(e);
      }
    }
    out.lastError = this.lastError;
    return out;
  }

  async _deliverWebhook(entry, { bypassBackoff = false } = {}) {
    const ts = this.now();
    if (!bypassBackoff) {
      if (ts < this._suppressUntil) return { ok: false, error: 'backoff_suppressed' };
      if (this._suppressUntil !== 0) { this._suppressUntil = 0; this._failures = []; } // window expired
    }
    if (this._rateLimited(ts)) return { ok: false, error: 'rate_limited' };
    this._sendTimes.push(ts);
    let ok = false;
    let error = null;
    try {
      const res = await this.fetchImpl(this.webhookUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(entry),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      ok = !!(res && res.ok);
      if (!ok) error = `http_${res ? res.status : 'none'}`;
    } catch (e) {
      ok = false;
      error = errStr(e);
    }
    if (!ok) {
      this.lastError = error;
      this._recordFailure(ts);
      this._auditRow({ type: 'audit_export_webhook', ok: false, error });
    }
    return { ok, error };
  }

  _rateLimited(ts) {
    this._sendTimes = this._sendTimes.filter((t) => ts - t < WEBHOOK_RATE_WINDOW_MS);
    return this._sendTimes.length >= WEBHOOK_RATE_LIMIT;
  }

  _recordFailure(ts) {
    this._failures.push(ts);
    this._failures = this._failures.filter((f) => ts - f < BACKOFF_WINDOW_MS);
    if (this._failures.length >= BACKOFF_FAILURES && ts >= this._suppressUntil) {
      this._suppressUntil = ts + BACKOFF_SUPPRESS_MS;
      this._failures = [];
      this._auditRow({
        type: 'audit_export_backoff',
        sink: 'webhook',
        reason: `${BACKOFF_FAILURES}_failures_in_60s`,
        suppressUntil: this._suppressUntil,
      });
    }
  }

  // S3 STUB — no AWS SDK. Local JSONL fallback shaped like the would-be
  // object key `<tenant>/<date>.jsonl`, plus an s3_upload_pending row that
  // names the bucket + key so an operator (or a future uploader) can drain
  // the fallback deliberately.
  _writeS3Stub(entry) {
    const tenant = (entry.payload
      && typeof entry.payload.tenant === 'string' && entry.payload.tenant) || 'main';
    const date = new Date(entry.ts || this.now()).toISOString().slice(0, 10);
    const key = `${tenant}/${date}.jsonl`;
    if (!this._s3Announced) {
      this._s3Announced = true;
      this._auditRow({ type: 'audit_export_s3_stub', bucket: this.bucket, region: this.region });
    }
    const dir = path.join(this.dataDir, tenant);
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(path.join(dir, `${date}.jsonl`), JSON.stringify(entry) + '\n');
    this._auditRow({ type: 's3_upload_pending', bucket: this.bucket, key });
  }

  _auditRow(payload) {
    try {
      if (this.gw && typeof this.gw._audit === 'function') this.gw._audit(payload);
    } catch { /* the sink must never break the caller */ }
  }
}

function trimOrNull(v) {
  return (typeof v === 'string' && v.trim().length > 0) ? v.trim() : null;
}

function errStr(e) {
  return String((e && e.message) || e).slice(0, MAX_ERROR_LEN);
}

// Per-gateway module-level sink — same WeakMap pattern as getAlertSink(gw)
// and getHub(gw). Env is read ONCE at first use; a restart re-reads it.
const _sinks = new WeakMap();

function getExportSink(gw) {
  let sink = _sinks.get(gw);
  if (!sink) {
    sink = new ExportSink(gw);
    _sinks.set(gw, sink);
  }
  return sink;
}

module.exports = {
  ExportSink,
  getExportSink,
  WEBHOOK_TIMEOUT_MS,
  WEBHOOK_RATE_LIMIT,
  WEBHOOK_RATE_WINDOW_MS,
  BACKOFF_FAILURES,
  BACKOFF_WINDOW_MS,
  BACKOFF_SUPPRESS_MS,
};
