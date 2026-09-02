'use strict';
// Playground panel (wave C UI) — C6 safe in-app code lab.
// Registers into window.TG_PANELS; core tab-router mounts render(hostEl)
// when the "Playground" tab is selected.
//
// Endpoint (src/gateway/mounts/80-playground.js):
//   POST /v2/playground/run  {lang:'js'|'html', code, timeoutMs?, memMB?}
//
// UI contract:
//   • two-pane: editor (textarea rows~14 monospace, live char count,
//     8000-char cap mirrored client-side) + run button; output <pre> with
//     exitCode badge + timing
//   • language toggle js/html
//   • js run → POST; on 202 shows needs_approval inline (chat/executor path
//     gates on approval; the panel path is human-driven)
//   • html → the server NEVER executes html; it returns the 'sandboxed'
//     preview token. The panel renders the html locally into a sandboxed
//     <iframe> built via createElement with the iframe.srcdoc PROPERTY
//     (never innerHTML — property assignment, and the sandbox='' attribute
//     without allow-scripts confines the content: scripts cannot run, no
//     same-origin access, forms/plugins blocked). The response token, not
//     the raw code, goes anywhere else.
//   • history: last 10 runs in memory only {ts, lang, exitCode} — code is
//     never stored client-side either
//   • example snippet buttons prefill benign demos (env keys count, primes)
//
// XSS policy: textContent only — no innerHTML anywhere (test-enforced).

(function () {
  if (!window.TG || !window.TG.api || !window.TG.el) return; // core shell not ready

  const api = window.TG.api;
  const el = window.TG.el;
  const CODE_CAP = 8000; // mirrored server-side cap (MAX_CODE_BYTES)
  const HISTORY_MAX = 10;

  const EXAMPLES = [
    {
      label: 'env keys count',
      lang: 'js',
      code: '// Benign demo: how many env vars does a jailed snippet see?\nconsole.log("env keys:", Object.keys(process.env).length);\nconsole.log("keys:", Object.keys(process.env).sort().join(", "));\n',
    },
    {
      label: 'primes',
      lang: 'js',
      code: '// Benign demo: first 20 primes.\nconst primes = [];\nfor (let n = 2; primes.length < 20; n++) {\n  if (primes.every((p) => n % p !== 0)) primes.push(n);\n}\nconsole.log(primes.join(" "));\n',
    },
    {
      label: 'html demo',
      lang: 'html',
      code: '<!doctype html>\n<html><head><meta charset="utf-8"><title>preview</title></head>\n<body><h1>Hello from the playground</h1>\n<p>This preview is confined by sandbox="" (no scripts).</p></body></html>\n',
    },
  ];

  function render(hostEl) {
    hostEl.textContent = '';
    const wrap = el('div', 'playground-panel');

    // ── toolbar: language toggle + examples ──────────────────────────
    const toolbar = el('div', 'pg-toolbar');
    let lang = 'js';
    const jsBtn = el('button', 'btn pg-lang active', 'js');
    const htmlBtn = el('button', 'btn pg-lang', 'html');
    toolbar.append(el('span', 'muted', 'language:'), jsBtn, htmlBtn);
    toolbar.append(el('span', 'pg-gap', ''));

    function setLang(l) {
      lang = l;
      jsBtn.classList.toggle('active', l === 'js');
      htmlBtn.classList.toggle('active', l === 'html');
      editor.placeholder = l === 'js' ? '// js snippet — runs in your bot jail' : '<!-- html preview — sandboxed, never executed server-side -->';
    }
    jsBtn.addEventListener('click', () => setLang('js'));
    htmlBtn.addEventListener('click', () => setLang('html'));
    for (const ex of EXAMPLES) {
      const b = el('button', 'btn pg-example', ex.label);
      b.addEventListener('click', () => {
        setLang(ex.lang);
        editor.value = ex.code;
        updateCount();
      });
      toolbar.append(b);
    }

    // ── editor pane ──────────────────────────────────────────────────
    const editor = document.createElement('textarea');
    editor.className = 'pg-editor';
    editor.rows = 14;
    editor.spellcheck = false;
    const count = el('span', 'muted pg-count', '0 / 8000');
    function updateCount() {
      count.textContent = String(editor.value.length) + ' / ' + CODE_CAP;
    }
    editor.addEventListener('input', updateCount);
    setLang('js');

    const runBtn = el('button', 'btn ok', 'run');
    const status = el('span', 'pg-status muted', '');
    const editorPane = el('div', 'pg-editor-pane');
    const editorHead = el('div', 'pg-editor-head');
    editorHead.append(count, runBtn, status);
    editorPane.append(editorHead, editor);

    // ── output pane ──────────────────────────────────────────────────
    const outHead = el('div', 'pg-out-head');
    const badge = el('span', 'tag', '');
    const timing = el('span', 'muted pg-timing', '');
    outHead.append(badge, timing);
    const outPre = el('pre', 'pg-output', '');
    const outPane = el('div', 'pg-out-pane');
    outPane.append(outHead, outPre);

    // ── history (in-memory, never stores code) ───────────────────────
    const history = el('div', 'pg-history muted', '');
    const hist = []; // {ts, lang, exitCode}
    function renderHistory() {
      history.textContent = 'recent: ' + (hist.length
        ? hist.map((h) => `${h.lang}·exit=${h.exitCode === null ? 'kill' : h.exitCode}`).join(' | ')
        : 'no runs yet');
    }
    renderHistory();

    // ── run flow ─────────────────────────────────────────────────────
    async function run() {
      const code = editor.value;
      if (!code.trim()) { status.textContent = 'nothing to run'; return; }
      if (code.length > CODE_CAP) {
        status.textContent = 'too long: ' + code.length + ' > ' + CODE_CAP;
        return;
      }
      runBtn.disabled = true;
      status.textContent = '…';
      if (lang === 'html') {
        // Server never executes html; render the local preview directly.
        // iframe.srcdoc via PROPERTY assignment (not innerHTML): content is
        // confined by the sandbox="" attribute (no allow-scripts) — scripts
        // cannot execute and the frame gets an opaque origin.
        outPre.textContent = '';
        outPre.classList.add('view-hide');
        let frame = outPane.querySelector('iframe.pg-frame');
        if (!frame) {
          frame = document.createElement('iframe');
          frame.className = 'pg-frame';
          frame.setAttribute('sandbox', '');
          outPane.appendChild(frame);
        }
        frame.srcdoc = code; // property assignment; sandbox confines it
        badge.textContent = 'preview';
        badge.className = 'tag approval';
        timing.textContent = 'sandboxed iframe — not executed server-side';
        status.textContent = 'preview rendered';
        hist.unshift({ ts: Date.now(), lang, exitCode: null });
        if (hist.length > HISTORY_MAX) hist.length = HISTORY_MAX;
        renderHistory();
        runBtn.disabled = false;
        return;
      }
      try {
        const res = await api('/v2/playground/run', {
          method: 'POST',
          body: JSON.stringify({ lang, code }),
        });
        const r = (res && res.result) || {};
        if (r.preview === 'sandboxed') {
          status.textContent = 'sandboxed preview token';
        }
        badge.textContent = r.exitCode === null && r.timedOut ? 'SIGKILL' : 'exit ' + (r.exitCode === undefined ? '?' : r.exitCode);
        badge.className = 'tag ' + (r.exitCode === 0 ? 'exec' : 'deny');
        timing.textContent = (r.durationMs != null ? r.durationMs + ' ms' : '') + (r.timedOut ? ' (timed out)' : '');
        outPre.textContent = [
          r.stdout ? 'stdout:\n' + r.stdout : '',
          r.stderr ? 'stderr:\n' + r.stderr : '',
        ].filter(Boolean).join('\n') || '(no output)';
        status.textContent = 'done';
        hist.unshift({ ts: Date.now(), lang, exitCode: r.exitCode === undefined ? null : r.exitCode });
        if (hist.length > HISTORY_MAX) hist.length = HISTORY_MAX;
        renderHistory();
      } catch (err) {
        if (err && err.status === 202) {
          // Chat/executor path: playground.run:* is destructive-classified,
          // so a proposal parks an approval — show it inline.
          status.textContent = 'needs_approval — a human operator must approve this run';
          badge.textContent = '202';
          badge.className = 'tag approval';
          outPre.textContent = err.body && err.body.reason ? String(err.body.reason) : 'queued for approval';
        } else if (err && err.status === 400) {
          status.textContent = 'rejected: ' + ((err.body && err.body.error) || 'bad request');
        } else {
          status.textContent = 'error ' + ((err && (err.status || err.message)) || '');
        }
      } finally {
        runBtn.disabled = false;
      }
    }
    runBtn.addEventListener('click', run);

    wrap.append(toolbar, editorPane, outPane, history);
    hostEl.append(wrap);
  }

  window.TG_PANELS = window.TG_PANELS || [];
  window.TG_PANELS.push({
    id: 'playground',
    title: 'Playground',
    render,
  });
})();