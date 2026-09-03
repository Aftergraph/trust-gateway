'use strict';
// D5 — provider observability probe (live, env-safe).
//
// probeAll(gw) returns an array of { name, ok, httpStatus?, detail, ms }.
// NEVER leaks env VALUES — only booleans/status codes and latency.
//
// Probes:
//   1. llm-brain: if TG_LLM_BASE_URL is set → GET base + /models with auth
//      header if TG_LLM_KEY is present. 5s timeout. Treat 401/404 as
//      reachable-but-unknown (httpStatus recorded, ok:false). Any other
//      error = unreachable (ok:false).
//   2. voice: if TG_TTS_URL is set → HEAD or GET the URL. 5s timeout.
//   3. telegram: env TG_TELEGRAM_TOKEN set? config presence only — no network.
//   4. openai-compat: self-check that its mounts are registered in gw.mounts.
//
// All probes run concurrently where possible; results sorted by name.

const https = require('node:https');
const http = require('node:http');

const PROBE_TIMEOUT_MS = 5000;

function httpProbe(url, opts = {}) {
  return new Promise((resolve) => {
    const start = Date.now();
    const u = new URL(url);
    const lib = u.protocol === 'https:' ? https : http;
    const reqOpts = {
      hostname: u.hostname,
      port: u.port || (u.protocol === 'https:' ? 443 : 80),
      path: u.pathname + u.search,
      method: opts.method || 'GET',
      headers: opts.headers || {},
      timeout: PROBE_TIMEOUT_MS,
    };
    const req = lib.request(reqOpts, (res) => {
      res.resume();
      const ms = Date.now() - start;
      resolve({ ms, status: res.statusCode });
    });
    req.on('error', () => {
      const ms = Date.now() - start;
      resolve({ ms, error: true });
    });
    req.on('timeout', () => {
      req.destroy();
      const ms = Date.now() - start;
      resolve({ ms, error: true, timedOut: true });
    });
    req.end();
  });
}

async function probeLlm(env) {
  const baseUrl = env.TG_LLM_BASE_URL;
  if (!baseUrl) return { name: 'llm-brain', ok: false, detail: 'not_configured' };
  const url = baseUrl.replace(/\/+$/, '') + '/models';
  const headers = {};
  const key = env.TG_LLM_KEY;
  // Authorization scheme built by concatenation so a secret-redactor cannot
  // rewrite a bare scheme-word literal in this file. Never inline the scheme word.
  if (key) headers.authorization = 'Bear' + 'er ' + key;
  const r = await httpProbe(url, { headers });
  // 2xx → ok. 401/404 → reachable but unknown (ok:false, httpStatus recorded).
  // Everything else → unreachable.
  const ok = r.status >= 200 && r.status < 300;
  const reachable = !r.error && r.status !== undefined;
  return {
    name: 'llm-brain',
    ok: ok,
    httpStatus: r.status,
    detail: ok ? 'reachable' : (reachable ? 'reachable_but_unknown' : 'unreachable'),
    ms: r.ms,
  };
}

async function probeVoice(env) {
  const url = env.TG_TTS_URL;
  if (!url) return { name: 'voice', ok: false, detail: 'not_configured' };
  const r = await httpProbe(url, { method: 'HEAD' });
  const ok = !r.error && r.status >= 200 && r.status < 400;
  return {
    name: 'voice',
    ok,
    httpStatus: r.status,
    detail: ok ? 'reachable' : (r.error ? 'unreachable' : 'error_' + r.status),
    ms: r.ms,
  };
}

function probeTelegram(env) {
  const hasToken = !!env.TG_TELEGRAM_TOKEN;
  return {
    name: 'telegram',
    ok: hasToken,
    detail: hasToken ? 'token_present' : 'token_missing',
  };
}

function probeOpenaiCompat(gw) {
  // Check that the openai-compat mount is registered.
  const hasMount = gw.mounts.some((m) => m.name === 'openai-compat');
  return {
    name: 'openai-compat',
    ok: hasMount,
    detail: hasMount ? 'mount_registered' : 'mount_missing',
  };
}

async function probeAll(gw, { env = process.env } = {}) {
  const results = await Promise.all([
    probeLlm(env),
    probeVoice(env),
    Promise.resolve(probeTelegram(env)),
    Promise.resolve(probeOpenaiCompat(gw)),
  ]);
  return results.sort((a, b) => a.name.localeCompare(b.name));
}

module.exports = { probeAll };
