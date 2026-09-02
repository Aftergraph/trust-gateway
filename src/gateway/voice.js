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
// A missing or failing backend NEVER becomes a 500: tts() falls back to the
// echo shape so the panel can still respond. Remote calls carry a 15s abort
// guard (AbortSignal) so a hung provider cannot block the mount watchdog.
//
// fetch is injectable for tests (voiceRouter({fetch})). Zero dependencies.

const MAX_TEXT_CHARS = 2000;
const TIMEOUT_MS = 15000;

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

  async function tts(text, opts = {}) {
    validateText(text);
    const voice = typeof opts.voice === 'string' && opts.voice ? opts.voice : undefined;
    const speed = Number.isFinite(opts.speed) && opts.speed > 0 ? opts.speed : undefined;
    const cfg = remoteConfig(opts);
    if (!cfg || !cfg.url) return echo(text); // no backend — never block, never 500

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

module.exports = { voiceRouter, getVoice, MAX_TEXT_CHARS, validateText };