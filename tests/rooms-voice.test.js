// B2 TDD — voice i rooms compose: push-to-talk (mic-knap) → POST /v2/voice/stt
// → transkript i inputfelt → ask. TTS-knap paa assistant-rækker → POST /v2/voice/tts
// → afspilning via Audio (fallback: no-op i test-shim).
// Statisk UI-kontrakt (samt de eksisterende voice-mount-tests forbliver grønne).
const test = require('node:test');
const assert = require('node:assert/strict');

test('B2 UI: mic-knap (push-to-talk) findes i compose-formen', () => {
  const src = require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'app', 'panels', 'rooms.js'), 'utf8');
  assert.match(src, /roommic|mic-btn/, 'mic-knap klasse');
  assert.match(src, /\/v2\/voice\/stt/, 'stt-kald');
  assert.ok(!/innerHTML\s*=/.test(src), 'no innerHTML');
});

test('B2 UI: TTS-knap paa assistant-rækker', () => {
  const src = require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'app', 'panels', 'rooms.js'), 'utf8');
  assert.match(src, /roommsg-tts|speak-btn/, 'tts-knap');
  assert.match(src, /\/v2\/voice\/tts/, 'tts-kald');
});

test('B2: eksisterende voice-endpoints findes (mount-objekt kontrakt)', () => {
  const mount = require('../src/gateway/mounts/60-voice.js');
  assert.ok(mount, 'voice mount eksporterer');
});
