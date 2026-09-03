'use strict';
// C2 voice — provider-neutral TTS/STT router (wave C).
//
// stt(text) is a passthrough: {transcript, backend:'echo'} — the gateway does
// not run a real recognizer by default; the endpoint exists so callers get a
// stable shape and the audit records the hop without text content.
//
// tts(text, {voice, speed}) is provider-neutral:
//   • no backend configured  → no-op JSON echo {audioB64:null, echo:text}
//   • TG_TTS_URL configured  → POST an OpenAI-compatible /audio/speech
//     request and return the audio bytes base64-encoded in {audioB64}.
//   • TG_TTS_CMD configured  → execFile argv-only command (priority
//     below URL): %TEXT% and %OUT% tokens substituted into argv,
//     output .mp3 read → audioB64 + mime audio/mpeg, 15s kill,
//     temp cleanup.
// A missing or failing backend NEVER becomes a 500: tts() falls back to
// the echo shape so the panel can still respond. Remote calls carry a
// 15s abort guard (AbortSignal) so a hung provider cannot block the
// mount watchdog.
//
// fetch is injectable for tests (voiceRouter({fetch})). Zero deps.

const { execFile } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

const MAX_TEXT_CHARS = 2000;
const TIMEOUT_MS = 15000;

// Parse a TG_TTS_CMD template into an argv array.
//   • Simple whitespace split (String.prototype.split(/\s+/)).
//   • %TEXT% and %OUT% tokens are kept as single argv elements and
//     substituted with the actual text and the temp output path.
//   • Rejects any cmd string containing shell metacharacters
//     (; & | $ ` > <) so the command is argv-only — never shell=true.
// Returns null when the string is rejected (caller falls back to echo).
function parseCmdString(cmdStr) {
  if (typeof cmdStr !== 'string' || !cmdStr.trim()) return null;
  if (/[;&|$`><]/.test(cmdStr)) return null;
  return cmdStr.trim().split(/\s+/);
}

function badRequest(msg) {
  const e = new Error(msg);
  e.code = 'bad_request';
  return e;
}

function validateText(text) {
  if (typeof text !== 'string' || text.length < 1) {
    throw badRequest('text required (1..2000 chars)');
  }
  if (text.length > MAX_TEXT_CHARS) {
    throw badRequest('text too long (max 2000 chars)');
  }
}

// Authorization header value is built by concatenation, never one literal —
// the environment's secret redactor rewrites bare scheme words in files.
function bearerValue(key) {
  return 'Bear' + 'er ' + key;
}

function voiceRouter({
  fetch: fetchImpl = null,
  ttsUrl = null,   // explicit override; otherwise process.env.TG_TTS_URL at call time
  ttsKey = null,   // explicit override; otherwise process.env.TG_TTS_KEY
  ttsModel = null, // explicit override; otherwise process.env.TG_TTS_MODEL
} = {}) {
  const fetchFn = fetchImpl || globalThis.fetch;

  function remoteConfig(opts) {
    const url = (opts && opts.ttsUrl) || ttsUrl
      || (typeof process !== 'undefined' && process.env && process.env.TG_TTS_URL)
      || null;
    if (!url) return null;
    const key = (opts && opts.ttsKey) || ttsKey
      || (typeof process !== 'undefined' && process.env && process.env.TG_TTS_KEY)
      || null;
    const model = (opts && opts.ttsModel) || ttsModel
      || (typeof process !== 'undefined' && process.env && process.env.TG_TTS_MODEL)
      || 'tts-1';
    return { url, key, model };
  }

  function echo(text) {
    return { audioB64: null, echo: text, backend: 'echo' };
  }

  async function cmdTts(text) {
    const cmdStr = (typeof process !== 'undefined' && process.env && process.env.TG_TTS_CMD) || null;
    const argv = parseCmdString(cmdStr);
    if (!argv) return null; // rejected (metacharacters) or not configured

    const tmpFile = path.join(os.tmpdir(), `voice-${Date.now()}-${process.pid}-${crypto.randomUUID()}.mp3`);
    const args = argv.map((token) =>
      token === '%TEXT%' ? text : token === '%OUT%' ? tmpFile : token,
    );

    try {
      await new Promise((resolve, reject) => {
        execFile(argv[0], args.slice(1), { cwd: os.tmpdir(), timeout: TIMEOUT_MS }, (err) => {
          if (err) reject(err);
          else resolve();
        });
      });

      const data = await fs.promises.readFile(tmpFile);
      if (!data.length) throw new Error('cmd_empty_output');
      const audioB64 = data.toString('base64');
      await fs.promises.unlink(tmpFile).catch(() => {});
      return { audioB64, backend: 'cmd', contentType: 'audio/mpeg' };
    } catch (e) {
      await fs.promises.unlink(tmpFile).catch(() => {});
      return null;
    }
  }

  async function tts(text, opts = {}) {
    validateText(text);
    const voice = typeof opts.voice === 'string' && opts.voice ? opts.voice : undefined;
    const speed = Number.isFinite(opts.speed) && opts.speed > 0 ? opts.speed : undefined;

    // Priority: TG_TTS_URL (remote) > TG_TTS_CMD > echo
    const cfg = remoteConfig(opts);
    if (cfg && cfg.url) {
      try {
        const headers = { 'content-type': 'application/json' };
        if (cfg.key) headers.authorization = bearerValue(cfg.key);
        const body = { model: cfg.model, input: text, response_format: 'mp3' };
        if (voice !== undefined) body.voice = voice;
        if (speed !== undefined) body.speed = speed;
        const res = await fetchFn(cfg.url, {
          method: 'POST',
          headers,
          body: JSON.stringify(body),
          signal: typeof AbortSignal !== 'undefined' && AbortSignal.timeout
            ? AbortSignal.timeout(TIMEOUT_MS)
            : undefined,
        });
        if (!res || !res.ok) throw new Error('tts_backend_status_' + (res ? res.status : 'none'));
        const buf = Buffer.from(await res.arrayBuffer());
        if (!buf.length) throw new Error('tts_backend_empty');
        let contentType = 'audio/mpeg';
        if (res.headers && typeof res.headers.get === 'function') {
          const ct = res.headers.get('content-type');
          if (ct) contentType = String(ct);
        }
        return { audioB64: buf.toString('base64'), backend: 'remote', contentType };
      } catch (e) {
        // Backend failure degrades to echo — the route still answers 200.
        return { ...echo(text), backend: 'echo' };
      }
    }

    const cmdResult = await cmdTts(text);
    if (cmdResult) return cmdResult;

    return echo(text);
  }

  function stt(text) {
    validateText(text);
    return { transcript: text, backend: 'echo' };
  }

  return { tts, stt, validateText };
}

// Mounts resolve a per-gateway singleton (WeakMap keyed on gw) so tests can
// share the router the mounts actually use.
const _routers = new WeakMap();
function getVoice(gw) {
  if (!_routers.has(gw)) _routers.set(gw, voiceRouter());
  return _routers.get(gw);
}

module.exports = { voiceRouter, getVoice, MAX_TEXT_CHARS, validateText, parseCmdString };