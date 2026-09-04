#!/usr/bin/env node
'use strict';
// bridge-telegram — Trust Gateway <-> Telegram bot bridge (Slice 4).
//
// Long-poll daemon. Env config:
//   TG_BRIDGE_TOKEN   required  — Telegram bot token (numeric:alpha)
//   TG_GATEWAY_URL    required  — http(s)://host:port of the trust gateway
//   TG_TOKEN          required  — gateway bearer (operator token)
//   TG_ALLOWED_USERS  optional  — comma-sep numeric Telegram user IDs.
//                                  EMPTY => deny-all (fail closed).
//
// Behaviour:
//   - getUpdates(offset) long-poll every cycle (timeout ~25s)
//   - network errors => backoff + log + continue (NEVER crash-loop)
//   - missing env => exit 1 with console message, no stacktrace
//
// Zero governance logic. All decisions live in the gateway behind
// `client` (GatewayClient). This file is plumbing only.

const https = require('node:https');
const { URL } = require('node:url');
const { GatewayClient } = require('../src/gateway/client');
const { createBridge, parseAllowedUsers, DEFAULT_LONG_POLL_TIMEOUT } = require('../src/bridge/telegram');

const REQUIRED_ENV = ['TG_BRIDGE_TOKEN', 'TG_GATEWAY_URL', 'TG_TOKEN'];

/**
 * Validate env. Returns either { ok:true, cfg } or { ok:false, message }.
 * Pure: never throws.
 */
function loadConfig(env = process.env) {
  const missing = REQUIRED_ENV.filter((k) => !env[k] || !String(env[k]).trim());
  if (missing.length) {
    return {
      ok: false,
      message: [
        'bridge-telegram: missing required env:',
        ...missing.map((k) => `  - ${k}`),
        '',
        'Set them and retry. Required:',
        '  TG_BRIDGE_TOKEN   Telegram bot token from @BotFather',
        '  TG_GATEWAY_URL    e.g. http://100.71.253.52:8800',
        '  TG_TOKEN          gateway bearer token (operator role)',
        '  TG_ALLOWED_USERS  optional, comma-sep Telegram user IDs (empty = deny-all)',
      ].join('\n'),
    };
  }
  return {
    ok: true,
    cfg: {
      bridgeToken: env.TG_BRIDGE_TOKEN.trim(),
      gatewayUrl: env.TG_GATEWAY_URL.trim().replace(/\/+$/, ''),
      gatewayToken: env.TG_TOKEN.trim(),
      allowedUsers: parseAllowedUsers(env.TG_ALLOWED_USERS),
    },
  };
}

/**
 * node:https POST against api.telegram.org. Returns parsed JSON body.
 * On network failure rejects with Error (caller logs + backoffs).
 *
 * @param {string} botToken
 * @param {string} method    e.g. 'getUpdates', 'sendMessage'
 * @param {object} [params]
 * @param {number} [timeoutMs=35000]
 */
function telegramCall(botToken, method, params = {}, timeoutMs = 35000) {
  const path = `/bot${botToken}/${method}`;
  const body = JSON.stringify(params);
  return new Promise((resolve, reject) => {
    const req = https.request({
      method: 'POST',
      hostname: 'api.telegram.org',
      port: 443,
      path,
      headers: {
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(body),
        'accept': 'application/json',
      },
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        if (!text) return resolve({});
        let parsed;
        try { parsed = JSON.parse(text); }
        catch (e) { return reject(new Error(`invalid JSON from telegram ${method}: ${e.message}`)); }
        if (parsed && parsed.ok === false && parsed.description) {
          return reject(new Error(`telegram ${method} failed: ${parsed.description}`));
        }
        resolve(parsed);
      });
      res.on('error', reject);
    });
    req.setTimeout(timeoutMs, () => {
      req.destroy(new Error(`telegram ${method} timed out after ${timeoutMs}ms`));
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

/**
 * Sleep helper for backoff. Doesn't throw.
 */
function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Run the long-poll loop until SIGINT/SIGTERM. Exposed for tests via
 * `startLoop({...})` — bin/bridge-telegram.js calls it after env validation.
 *
 * @param {object} opts
 * @param {ReturnType<typeof createBridge>} opts.bridge
 * @param {string} opts.botToken  unused now; kept for back-compat. The loop
 *        uses `opts.tgCall` which already carries the token.
 * @param {(method:string, params:object)=>Promise<unknown>} [opts.tgCall]
 *        Production: the `telegramCall(botToken, ...)` wrapper. Tests
 *        inject a stub. Falls back to calling telegramCall(botToken, ...).
 * @param {boolean} [opts.exitOnStop=false]  if true, process.exit(0) when stopped
 * @param {(code:number)=>void} [opts.onExit]
 * @param {(ms:number)=>Promise<void>} [opts.sleepImpl]  backoff sleeper (testable)
 */
async function startLoop({ bridge, botToken, tgCall: tgCallIn, exitOnStop = false, onExit, sleepImpl = sleep } = {}) {
  if (!bridge) throw new Error('startLoop: bridge required');
  // If no tgCall injected, build one from the production wrapper.
  const tgCall = tgCallIn || ((method, params) => telegramCall(botToken, method, params));
  let offset = 0;
  let backoffMs = 0;
  let stopping = false;

  const stop = (code) => {
    stopping = true;
    if (typeof onExit === 'function') onExit(code);
    if (exitOnStop) process.exit(code);
  };
  process.once('SIGINT',  () => stop(0));
  process.once('SIGTERM', () => stop(0));

  while (!stopping) {
    if (backoffMs > 0) {
      await sleepImpl(backoffMs);
      backoffMs = 0;
    }
    let updates;
    try {
      updates = await tgCall(
        'getUpdates',
        { offset, timeout: DEFAULT_LONG_POLL_TIMEOUT, allowed_updates: ['message', 'callback_query'] },
      );
    } catch (err) {
      // Network glitch — log + exponential backoff (cap 30s). NEVER crash.
      console.error('[bridge] getUpdates failed:', err.message || err);
      backoffMs = Math.min(backoffMs === 0 ? 1000 : backoffMs * 2, 30000);
      continue;
    }
    const list = Array.isArray(updates?.result) ? updates.result : [];
    for (const u of list) {
      try {
        const specs = await bridge.handleUpdate(u);
        for (const spec of specs) {
          try {
            await tgCall(spec.method, spec.params || {});
          } catch (sendErr) {
            console.error('[bridge] send', spec.method, 'failed:', sendErr.message || sendErr);
            // Sending failed — keep going. Next loop will catch up.
          }
        }
      } catch (updErr) {
        console.error('[bridge] update handler crashed:', updErr.message || updErr);
        // Self-heal: keep polling.
      }
      if (typeof u.update_id === 'number' && u.update_id >= offset) {
        offset = u.update_id + 1;
      }
    }
  }
}

/**
 * Public entry point. Returns a numeric exit code so the bin wrapper can
 * `process.exit(code)`. Never throws.
 */
async function main(env = process.env, { exitOnStop = true } = {}) {
  const loaded = loadConfig(env);
  if (!loaded.ok) {
    console.error(loaded.message);
    return 1;
  }
  const { bridgeToken, gatewayUrl, gatewayToken, allowedUsers } = loaded.cfg;
  const client = new GatewayClient({ baseUrl: gatewayUrl, token: gatewayToken });
  const tgCall = (method, params) => telegramCall(bridgeToken, method, params);
  const bridge = createBridge({ client, tgCall, allowedUsers });
  await startLoop({ bridge, botToken: bridgeToken, tgCall, exitOnStop });
  return 0;
}

if (require.main === module) {
  main().then((code) => {
    process.exitCode = code;
  }).catch((e) => {
    // Defensive: env validation already covers missing config; this is
    // belt-and-braces. Never let an uncaught exception bubble out.
    console.error('bridge-telegram: fatal:', (e && e.message) || e);
    process.exitCode = 1;
  });
}

module.exports = {
  main,
  startLoop,
  loadConfig,
  telegramCall,
  parseAllowedUsers,
  REQUIRED_ENV,
};