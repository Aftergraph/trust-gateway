'use strict';
// FS-I6 — gateway config hot-reload: SIGHUP / POST /v2/config/reload re-reads
// operator thresholds WITHOUT a restart.
//
// Source of truth per reload:
//   data/gateway.env  (KEY=VALUE lines, '#' comments, optional quotes) when
//   the file exists — file entries override process.env; keys absent from the
//   file fall back to process.env. No file → process.env only.
//   Location: $TG_DATA_DIR/gateway.env, else <cwd>/data/gateway.env.
//
// Reloadable keys (thresholds + routing only — nothing secret, nothing that
// binds a socket or an identity):
//   TG_ALERT_URLS                  comma-separated webhook targets
//   TG_ALERT_RATELIMIT_THRESHOLD   positive integer
//   TG_ALERT_CHAIN_STALL_SEC       positive integer
//   TG_TENANT_DEFAULT_DISK_MB      positive integer
//   TG_TENANT_DEFAULT_API_PER_HOUR positive integer
//   TG_FED_RUNS_PER_HOUR           positive integer
//   TG_FED_RUNS_PER_SKILL_HOUR     positive integer
//
// NOT reloadable (requires restart, by design): BOT_TOKENS (credentials are
// read once at boot; a reload must never be able to swap identities) and
// PORT (the listener socket is bound at boot). If those appear in
// gateway.env they are refused with a `not_reloadable` error, old values
// kept.
//
// Semantics:
//   - `changed` lists only keys whose effective value differs from what the
//     gateway started with (or last reloaded to). Unchanged keys are never
//     listed.
//   - An invalid value (non-integer / <= 0 for integer keys) is recorded in
//     `errors` and the PREVIOUS value stays in effect — fail-safe, never
//     fail-open.
//   - On change, both gw.config[key] and process.env[key] are updated so
//     live consumers (skills-federation capFromEnv, AlertSink) pick the new
//     value up on their next read without any code change.
//   - reload() NEVER throws: every failure is captured in `errors` and the
//     gateway keeps running with its previous configuration.
//
// Audit hygiene: callers audit `config_reloaded` / `config_reload_failed`
// with key NAMES and error kinds only — never secret values. (The only raw
// value ever carried in `errors` is an invalid numeric value, truncated to
// 60 chars; URLs parse unconditionally so targets are never echoed.)

const fs = require('node:fs');
const path = require('node:path');
const { parseUrls } = require('./alerting');

const KEYS = [
  { name: 'TG_ALERT_URLS', kind: 'urls' },
  { name: 'TG_ALERT_RATELIMIT_THRESHOLD', kind: 'int' },
  { name: 'TG_ALERT_CHAIN_STALL_SEC', kind: 'int' },
  { name: 'TG_TENANT_DEFAULT_DISK_MB', kind: 'int' },
  { name: 'TG_TENANT_DEFAULT_API_PER_HOUR', kind: 'int' },
  { name: 'TG_FED_RUNS_PER_HOUR', kind: 'int' },
  { name: 'TG_FED_RUNS_PER_SKILL_HOUR', kind: 'int' },
];

// Deliberately NOT hot-reloadable — see module header.
const NON_RELOADABLE = ['BOT_TOKENS', 'PORT'];
const _NON_RELOADABLE = new Set(NON_RELOADABLE);

const VALUE_TRUNC = 60;

// Startup snapshot — captured at module load (gateway construction time).
// This is the baseline "what the gateway is currently running with"; a first
// SIGHUP that points the process at a gateway.env reports every key the file
// actually changes, and nothing else.
const BASELINE_RAW = {};
for (const spec of KEYS) BASELINE_RAW[spec.name] = process.env[spec.name];

function gatewayEnvPath() {
  const dir = process.env.TG_DATA_DIR || path.join(process.cwd(), 'data');
  return path.join(dir, 'gateway.env');
}

/** Parse KEY=VALUE lines → {values, errors:[{line,error}]}. Tolerant. */
function parseEnvFile(text) {
  const values = {};
  const errors = [];
  String(text).split(/\r?\n/).forEach((rawLine, i) => {
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith('#')) return;
    const eq = line.indexOf('=');
    if (eq <= 0) {
      errors.push({ line: i + 1, error: 'malformed_line' });
      return;
    }
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    if (val.length >= 2 && ((val[0] === '"' && val.endsWith('"')) || (val[0] === "'" && val.endsWith("'")))) {
      val = val.slice(1, -1);
    }
    values[key] = val;
  });
  return { values, errors };
}

/**
 * Parse one key's raw value. Returns the canonical parsed form:
 * urls → string[], int → positive integer, unset → null ("default applies").
 * Throws Error('invalid_value') on garbage — callers keep the old value.
 */
function parseValue(spec, raw) {
  if (raw === undefined || raw === null || String(raw).trim() === '') return null;
  const s = String(raw).trim();
  if (spec.kind === 'urls') return parseUrls(s);
  const n = Number(s);
  if (!Number.isInteger(n) || n <= 0) throw new Error('invalid_value');
  return n;
}

// Baseline parse is tolerant: garbage at boot stays garbage (the running
// consumer defaults already applied at boot); reload only reports deltas.
function baselineFor(spec) {
  try {
    return { parsed: parseValue(spec, BASELINE_RAW[spec.name]), raw: BASELINE_RAW[spec.name] };
  } catch {
    return { parsed: null, raw: BASELINE_RAW[spec.name] };
  }
}

/**
 * Re-read the environment source and update gw.config in-place.
 * Never throws. Returns {changed: string[], errors: object[]}.
 */
async function reload(gw) {
  const changed = [];
  const errors = [];
  try {
    if (!gw || typeof gw !== 'object') throw new Error('reload(gw) requires a gateway instance');
    if (!gw.config || typeof gw.config !== 'object') gw.config = {};
    // Seed the per-gateway baseline once (gateway-startup values).
    if (!gw._hotReloadRaw || typeof gw._hotReloadRaw !== 'object') {
      gw._hotReloadRaw = {};
      for (const spec of KEYS) {
        const b = baselineFor(spec);
        gw.config[spec.name] = b.parsed;
        gw._hotReloadRaw[spec.name] = b.raw === undefined || b.raw === null ? '' : String(b.raw).trim();
      }
    }

    // Source: gateway.env overrides process.env; missing file → env only.
    let fileValues = null;
    const file = gatewayEnvPath();
    try {
      const { values, errors: fileErrors } = parseEnvFile(fs.readFileSync(file, 'utf8'));
      for (const e of fileErrors) errors.push(e);
      fileValues = values;
    } catch (e) {
      if (e && e.code !== 'ENOENT') errors.push({ file: path.basename(file), error: 'read_failed' });
    }
    const sourceFor = (key) =>
      fileValues && Object.prototype.hasOwnProperty.call(fileValues, key) ? fileValues[key] : process.env[key];

    for (const spec of KEYS) {
      const raw = sourceFor(spec.name);
      let parsed;
      try {
        parsed = parseValue(spec, raw);
      } catch {
        // Fail-safe: log, keep the previous value in effect.
        errors.push({ key: spec.name, value: String(raw).slice(0, VALUE_TRUNC), error: 'invalid_value' });
        continue;
      }
      const rawKey = raw === undefined || raw === null ? '' : String(raw).trim();
      if (rawKey === gw._hotReloadRaw[spec.name]) continue; // unchanged → not listed
      gw.config[spec.name] = parsed;
      gw._hotReloadRaw[spec.name] = rawKey;
      // Keep process.env in sync so live consumers read the new value.
      if (rawKey === '') delete process.env[spec.name];
      else process.env[spec.name] = rawKey;
      changed.push(spec.name);
    }

    // Restart-only keys must never be hot-swapped — refuse explicitly.
    if (fileValues) {
      for (const key of Object.keys(fileValues)) {
        if (_NON_RELOADABLE.has(key)) errors.push({ key, error: 'not_reloadable' });
      }
    }

    // Live consumer refresh: the per-gateway AlertSink re-reads the new
    // TG_ALERT_URLS / TG_ALERT_TOKEN. Best-effort — never fails the reload.
    try {
      const { getAlertSink } = require('./alerting');
      getAlertSink(gw).configure({ urls: null, env: process.env });
    } catch { /* sink unavailable — thresholds still reloaded */ }

    return { changed, errors };
  } catch (e) {
    // Absolute last resort: report, keep every old value.
    errors.push({ error: String((e && e.message) || e).slice(0, 120) });
    return { changed, errors };
  }
}

module.exports = {
  reload,
  KEYS,
  NON_RELOADABLE,
  parseEnvFile,
  parseValue,
  gatewayEnvPath,
};
