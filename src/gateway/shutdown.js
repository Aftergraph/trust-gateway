'use strict';
// FS-Y3 — graceful shutdown endpoint.
// POST /v2/shutdown (operator-only) marks the gateway as draining
// (refuses new connections but completes in-flight ones), then
// triggers process.exit after a grace period. Optional delay via
// TG_SHUTDOWN_GRACE_MS (default 5000).
//
// Inert (returns ok:false) when TG_GRACEFUL_SHUTDOWN unset.
// SAFETY: requires operator + a body {confirm: 'shutdown'} to prevent
// accidental triggers.

function enabled() {
  return process.env.TG_GRACEFUL_SHUTDOWN === '1';
}

function graceMs() {
  const raw = process.env.TG_SHUTDOWN_GRACE_MS;
  if (raw === undefined) return 5000;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return 5000;
  return n;
}

let _draining = false;
let _drainStartedAt = null;

function isDraining() { return _draining; }
function drainStartedAt() { return _drainStartedAt; }

function beginDrain() {
  _draining = true;
  _drainStartedAt = Date.now();
}

/**
 * Schedule a process exit. Returns the grace period in ms.
 * Caller (mount) is responsible for actual process.exit.
 */
function scheduleExit() {
  const ms = graceMs();
  setTimeout(() => {
    try { process.exit(0); } catch { /* already exiting */ }
  }, ms);
  return ms;
}

module.exports = {
  enabled,
  graceMs,
  isDraining,
  drainStartedAt,
  beginDrain,
  scheduleExit,
};
