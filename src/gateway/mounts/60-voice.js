'use strict';
// C2 mount — voice TTS/STT HTTP surface (wave C).
//
//   POST /v2/voice/tts  {text, voice?, speed?} → {audioB64, backend, ...}
//   POST /v2/voice/stt  {text}                 → {transcript, backend}
//
// Auth: bearer (mount runner resolves bot before this handler runs).
// Validation: text must be 1..2000 chars (shared with the router).
// AUDIT HYGIENE: voice_tts / voice_stt payloads record backend + chars only —
// NEVER the text content (free text could carry secrets).
// Response time guard: the mount answers within 15s (router aborts remote
// calls at 15s; the watchdog timer here is the outer belt-and-braces guard).

const { send, readBody } = require('../server');
const { getVoice } = require('../voice');

const MAX_CHARS = 2000;
const GUARD_MS = 15000;

function readJson(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > 256 * 1024) { reject(new Error('body_too_large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')); }
      catch { reject(new Error('invalid_json')); }
    });
    req.on('error', reject);
  });
}

function validate(text) {
  if (typeof text !== 'string' || text.length < 1) return 'text required (1..2000 chars)';
  if (text.length > MAX_CHARS) return 'text too long (max 2000 chars)';
  return null;
}

function withGuard(res, work) {
  // Outer response-time guard: if the work hasn't settled within GUARD_MS,
  // answer 504 and remember it — a late resolution must never double-send.
  const state = { responded: false };
  const timer = setTimeout(() => {
    state.responded = true;
    if (!res.headersSent) send(res, 504, { error: 'voice_timeout' });
  }, GUARD_MS);
  return Promise.resolve()
    .then(work)
    .then((out) => ({ responded: state.responded, out, err: null }))
    .catch((e) => ({ responded: state.responded, out: null, err: e }))
    .finally(() => clearTimeout(timer));
}

module.exports = {
  name: 'v2-voice',
  method: '*',
  path: /^\/v2\/voice\/(tts|stt)$/,
  auth: 'bearer',
  handle: async (gw, req, res, ctx) => {
    const sub = ctx.params && ctx.params.matches ? ctx.params.matches[1] : null;
    if (req.method !== 'POST' || !sub) return send(res, 405, { error: 'method_not_allowed' });

    let body;
    try {
      body = await readJson(req);
    } catch (e) {
      return send(res, e.message === 'body_too_large' ? 413 : 400, { error: e.message });
    }
    const err = validate(body.text);
    if (err) return send(res, 400, { error: 'invalid_text', message: err });

    const text = body.text;
    const voice = getVoice(gw);

    if (sub === 'tts') {
      const voiceName = typeof body.voice === 'string' && body.voice ? body.voice : undefined;
      const speed = Number.isFinite(body.speed) && body.speed > 0 ? body.speed : undefined;
      const r = await withGuard(res, () => voice.tts(text, { voice: voiceName, speed }));
      // The 15s guard already answered (or the handler raced it) — stop here.
      if (r.responded || r.err) {
        if (r.err && !res.headersSent) send(res, 502, { error: 'voice_failed' });
        return;
      }
      const out = r.out;
      const backend = out.backend || (out.audioB64 ? 'remote' : 'echo');
      // chars only — the text itself never enters the audit chain
      gw._audit({ type: 'voice_tts', backend, chars: text.length });
      return send(res, 200, out);
    }

    // stt — passthrough
    const out = voice.stt(text);
    gw._audit({ type: 'voice_stt', backend: out.backend || 'echo', chars: text.length });
    return send(res, 200, out);
  },
};