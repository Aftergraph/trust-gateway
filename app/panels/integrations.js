'use strict';
// Integrations panel (wave C UI) — C4 adapter registry console section.
// Registers into window.TG_PANELS; the core tab-router mounts render(hostEl)
// when the "Integrations" tab is selected.
//
// Endpoints (src/gateway/mounts/70-adapters.js):
//   GET    /v2/adapters             list (secret-free)
//   POST   /v2/adapters             register {kind, name, config}
//   PATCH  /v2/adapters/:id         update {enabled?, name?, config?}
//   DELETE /v2/adapters/:id         remove
//   POST   /v2/adapters/:id/test    probe → {result: ok|fail|blocked}
//   POST   /v2/adapters/:id/secret  {name, value} — stored as hash only
//
// UI contract:
//   • adapter cards: kind badge, name, host-only URL display (never a full
//     URL — secrets hide in query strings), enabled toggle, test button that
//     shows ok/fail/blocked inline, delete with confirm()
//   • register form: kind select (webhook/http-api/telegram/email/calendar),
//     name input, url/baseUrl input
//   • secret form: input type=password — the value is sent once and NEVER
//     echoed back anywhere; after save the card shows name + length only
//
// XSS policy: textContent only — no innerHTML anywhere (test-enforced).

(function () {
  if (!window.TG || !window.TG.api || !window.TG.el) return; // core shell not ready

  const api = window.TG.api;
  const el = window.TG.el;

  const KINDS = ['webhook', 'http-api', 'telegram', 'email', 'calendar'];
  const RESULT_TEXT = { ok: 'ok', fail: 'fail', blocked: 'blocked' };

  // one card per adapter: badge, name, host-only, toggle, test, delete, secrets
  function adapterCard(def, refresh) {
    const card = el('div', 'adapter-card');
    const head = el('div', 'adapter-head');
    head.append(el('span', 'adapter-kind badge ' + String(def.kind).replace(/[^a-z-]/g, ''), def.kind));
    head.append(el('b', null, def.name || def.id));
    if (def.host) head.append(el('span', 'adapter-host muted', def.host));

    // enabled toggle
    const toggle = el('button', 'btn ' + (def.enabled ? 'ok' : ''), def.enabled ? 'enabled' : 'disabled');
    toggle.addEventListener('click', () => {
      api('/v2/adapters/' + encodeURIComponent(def.id), {
        method: 'PATCH',
        body: JSON.stringify({ enabled: !def.enabled }),
      }).then(refresh).catch(() => { window.alert('toggle failed'); });
    });
    head.append(toggle);

    // test button → inline ok/fail/blocked
    const testMsg = el('span', 'adapter-test-result muted', '');
    const testBtn = el('button', 'btn', 'test');
    testBtn.addEventListener('click', () => {
      testMsg.textContent = '…';
      api('/v2/adapters/' + encodeURIComponent(def.id) + '/test', { method: 'POST', body: '{}' })
        .then((d) => { testMsg.textContent = RESULT_TEXT[d.result] || d.result || 'error'; })
        .catch((err) => { testMsg.textContent = 'error ' + (err.status || err.message || ''); });
    });
    head.append(testBtn, testMsg);

    // delete with confirm()
    const drop = el('button', 'btn no', 'delete');
    drop.addEventListener('click', () => {
      if (!window.confirm('delete adapter ' + (def.name || def.id) + '?')) return;
      api('/v2/adapters/' + encodeURIComponent(def.id), { method: 'DELETE' })
        .then(refresh)
        .catch(() => window.alert('delete failed'));
    });
    head.append(drop);
    card.append(head);

    // secrets line: name + length only (value never echoed back)
    const names = Object.keys(def.secrets || {});
    if (names.length) {
      const line = el('div', 'adapter-secrets muted', '');
      for (const n of names) {
        const s = def.secrets[n] || {};
        line.append(el('span', 'adapter-secret', n + ' (' + s.length + ' chars)'));
      }
      card.append(line);
    }
    return card;
  }

  function render(hostEl) {
    hostEl.textContent = '';
    const wrap = el('div', 'integrations-panel');

    // ── register form: kind select + name + url/baseUrl ─────────────────
    const form = el('form', 'adapter-create');
    const kindSel = el('select', 'adapter-in');
    for (const k of KINDS) {
      const opt = el('option', null, k);
      opt.value = k;
      kindSel.append(opt);
    }
    const nameIn = el('input', 'adapter-in');
    nameIn.placeholder = 'adapter name';
    const urlIn = el('input', 'adapter-in');
    urlIn.placeholder = 'url / baseUrl';
    const mk = el('button', 'btn ok', 'register adapter');
    const formMsg = el('span', 'muted', '');
    form.append(kindSel, nameIn, urlIn, mk, formMsg);
    form.addEventListener('submit', (ev) => {
      ev.preventDefault();
      const kind = kindSel.value;
      const name = nameIn.value.trim();
      const raw = urlIn.value.trim();
      if (!name) { formMsg.textContent = 'name required'; return; }
      const config = {};
      if (kind === 'webhook') config.url = raw;
      else if (kind === 'http-api') { config.baseUrl = raw; config.auth = 'header'; }
      else if (kind === 'telegram') config.botRef = raw;
      formMsg.textContent = '…';
      api('/v2/adapters', { method: 'POST', body: JSON.stringify({ kind, name, config }) })
        .then(() => { formMsg.textContent = 'registered'; nameIn.value = ''; urlIn.value = ''; refreshList(); })
        .catch((err) => { formMsg.textContent = 'error ' + (err.status || err.message || ''); });
    });

    // ── secret form: password input, value sent once, never echoed ──────
    const secretForm = el('form', 'adapter-secret');
    const secretId = el('input', 'adapter-in');
    secretId.placeholder = 'adapter id';
    const secretName = el('input', 'adapter-in');
    secretName.placeholder = 'secret name';
    const secretVal = el('input', 'adapter-in');
    secretVal.placeholder = 'secret value';
    secretVal.type = 'password';
    const setBtn = el('button', 'btn ok', 'set secret');
    const secretMsg = el('span', 'muted', '');
    secretForm.append(secretId, secretName, secretVal, setBtn, secretMsg);
    secretForm.addEventListener('submit', (ev) => {
      ev.preventDefault();
      const id = secretId.value.trim();
      const name = secretName.value.trim();
      const value = secretVal.value;
      if (!id || !name || !value) { secretMsg.textContent = 'id, name, value required'; return; }
      secretMsg.textContent = '…';
      api('/v2/adapters/' + encodeURIComponent(id) + '/secret', {
        method: 'POST',
        body: JSON.stringify({ name, value }),
      })
        .then((d) => {
          // show length only — the value itself is never rendered back
          secretMsg.textContent = 'saved ' + name + ' (' + (d && d.length) + ' chars)';
          secretVal.value = ''; // clear the password field immediately
          refreshList();
        })
        .catch((err) => {
          secretMsg.textContent = 'error ' + (err.status || err.message || '');
          secretVal.value = '';
        });
    });

    // ── adapter list ────────────────────────────────────────────────────
    const list = el('div', 'adapter-list');

    function refreshList() {
      api('/v2/adapters')
        .then((d) => {
          list.textContent = '';
          const adapters = (d && d.adapters) || [];
          if (!adapters.length) { list.append(el('div', 'empty', 'no adapters — register one above')); return; }
          for (const def of adapters) list.append(adapterCard(def, refreshList));
        })
        .catch(() => {
          list.textContent = '';
          list.append(el('div', 'empty', window.TG.authed() ? 'adapters unavailable' : 'enter a token to load adapters'));
        });
    }

    // live refresh on registry changes from the shared SSE audit fan-out
    window.TG.onAudit((e) => {
      const t = e && e.payload && e.payload.type;
      if (t === 'adapter_registered' || t === 'adapter_updated' || t === 'adapter_deleted' || t === 'adapter_secret_set') refreshList();
    });

    wrap.append(form, secretForm, list);
    hostEl.append(wrap);
    refreshList();
  }

  (window.TG_PANELS = window.TG_PANELS || []).push({ id: 'integrations', title: 'Integrations', render });
})();