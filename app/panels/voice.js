'use strict';
// Voice panel (wave C UI) — C2 TTS/STT console section.
// Registers into window.TG_PANELS; the core tab-router mounts render(hostEl)
// when the "Voice" tab is selected.
//
// Endpoints (src/gateway/mounts/60-voice.js):
//   POST /v2/voice/tts  {text, voice?, speed?} → {audioB64, backend, echo?}
//   POST /v2/voice/stt  {text}                 → {transcript, backend}
//
// UI contract:
//   • textarea for the text, speak button → POST /v2/voice/tts
//   • when the response carries audioB64, decode it to a data: URI and play
//     via new Audio(url) — the Audio object is created in JS, never markup
//   • with no backend configured the gateway answers {audioB64:null, echo}
//     and the panel shows the echoed text in the status line
//   • transcribe button → POST /v2/voice/stt (echo transcript shown)
//   • one status line reports backend + outcome
//
// XSS policy: textContent only — no innerHTML anywhere (test-enforced).

(function () {
  if (!window.TG || !window.TG.api || !window.TG.el) return; // core shell not ready

  const api = window.TG.api;
  const el = window.TG.el;
  const MAX_CHARS = 2000;

  function render(hostEl) {
    hostEl.textContent = '';
    const wrap = el('div', 'voice-panel');

    const head = el('div', 'voice-head');
    head.append(el('h3', null, 'Voice'));
    head.append(el('span', 'muted', 'text to speech / transcribe (provider-neutral)'));
    wrap.append(head);

    const ta = document.createElement('textarea');
    ta.className = 'voice-text';
    ta.placeholder = 'text to speak (max ' + MAX_CHARS + ' chars)';
    ta.rows = 4;
    wrap.append(ta);

    const controls = el('div', 'voice-controls');
    const speakBtn = el('button', 'btn ok', 'speak');
    const transcribeBtn = el('button', 'btn', 'transcribe');
    const status = el('span', 'voice-status muted', '');
    controls.append(speakBtn, transcribeBtn, status);
    wrap.append(controls);

    function failStatus(err) {
      status.textContent = 'error ' + (err && err.status ? err.status : (err && err.message) || '');
    }

    speakBtn.addEventListener('click', () => {
      const text = ta.value.trim();
      if (!text) { status.textContent = 'enter text first'; return; }
      if (text.length > MAX_CHARS) { status.textContent = 'too long (max 2000 chars)'; return; }
      status.textContent = '…';
      api('/v2/voice/tts', {
        method: 'POST',
        body: JSON.stringify({ text }),
      })
        .then((d) => {
          if (d && typeof d.audioB64 === 'string' && d.audioB64.length) {
            // decode base64 audio → data: URI → play; the Audio object is
            // created here in JS (never via markup, per the XSS policy)
            const bin = atob(d.audioB64);
            const bytes = new Uint8Array(bin.length);
            for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
            const blob = new (window.Blob || Blob)([bytes], { type: d.contentType || 'audio/mpeg' });
            const url = (window.URL || URL).createObjectURL(blob);
            const player = new (window.Audio || Audio)(url);
            player.addEventListener('ended', () => (window.URL || URL).revokeObjectURL(url));
            player.play().catch(() => {
              (window.URL || URL).revokeObjectURL(url);
              status.textContent = 'playback blocked — ' + (d.backend || 'remote');
            });
            status.textContent = 'playing (' + (d.backend || 'remote') + ')';
          } else if (d && d.backend === 'echo') {
            status.textContent = 'no voice backend configured — echo';
          } else {
            status.textContent = 'no audio returned';
          }
        })
        .catch(failStatus);
    });

    transcribeBtn.addEventListener('click', () => {
      const text = ta.value.trim();
      if (!text) { status.textContent = 'enter text first'; return; }
      if (text.length > MAX_CHARS) { status.textContent = 'too long (max 2000 chars)'; return; }
      status.textContent = '…';
      api('/v2/voice/stt', { method: 'POST', body: JSON.stringify({ text }) })
        .then((d) => {
          const t = d && typeof d.transcript === 'string' ? d.transcript : '';
          status.textContent = t ? 'heard: ' + t : 'no transcript';
        })
        .catch(failStatus);
    });

    hostEl.append(wrap);
  }

  (window.TG_PANELS = window.TG_PANELS || []).push({ id: 'voice', title: 'Voice', render });
})();