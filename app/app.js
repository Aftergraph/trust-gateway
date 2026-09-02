'use strict';
// Trust Gateway v2 operator console — zero framework.
// XSS policy: all payload-derived strings go through textContent/createTextNode.
// NEVER interpolate server/bot data into innerHTML. Static templates only.
(function () {
  const $ = (id) => document.getElementById(id);
  const tokenEl = $('tokenInput');
  let token = localStorage.getItem('tg_token') || new URLSearchParams(location.search).get('token') || '';
  tokenEl.value = token ? '••••••••' : '';
  let es = null;
  let chatOk = null; // feature-detect /v2/chat once
  const sessionId = 'web-' + Math.random().toString(36).slice(2, 10);

  function authed() { return token && token.length > 0; }
  function saveToken() { localStorage.setItem('tg_token', token); }

  async function api(path, opts) {
    const res = await fetch(path, Object.assign({
      headers: Object.assign({ 'content-type': 'application/json' }, (opts && opts.headers) || {}),
    }, opts || {}, { headers: Object.assign({}, (opts && opts.headers) || {}, authed() ? { authorization: 'Bearer ' + token } : {}) }));
    if (res.status === 401) throw Object.assign(new Error('unauthorized'), { status: 401 });
    if (res.status === 403) throw Object.assign(new Error('operator_required'), { status: 403 });
    return res.json();
  }

  function el(tag, cls, text) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined) n.textContent = text;
    return n;
  }

  function setPill(ok) {
    const p = $('chainPill');
    p.textContent = ok ? 'SEALED ✓' : 'TAMPERED ✖';
    p.className = 'pill ' + (ok ? 'sealed' : 'tambered');
  }

  const TAG_CLASS = {
    action_decision: 'decision', action_executed: 'exec',
    approval_requested: 'approval', approval_resolved: 'approval',
    auth_rejected: 'deny', action_executed_after_approval: 'exec',
    chat_action: 'chat', chat_action_executed: 'exec',
    approval_forbidden: 'deny', genesis: 'other',
  };

  function streamRow(e) {
    const row = el('div', 'row');
    const age = el('span', 'age', new Date(e.ts).toLocaleTimeString());
    const tag = el('span', 'tag ' + (TAG_CLASS[e.payload.type] || 'other'), e.payload.type);
    const bot = el('span', 'who', e.payload.bot || e.payload.approver || '');
    const tool = el('span', 'tool', e.payload.tool || '');
    const dec = e.payload.decision ? el('span', 'dec ' + e.payload.decision, e.payload.decision) : null;
    const hash = el('span', 'hash', '#' + e.seq + ' ' + String(e.hash).slice(0, 8));
    row.append(age, tag, bot, tool);
    if (dec) row.append(dec);
    row.append(hash);
    return row;
  }

  function primeStream() {
    $('stream').textContent = '';
    api('/v1/audit?since=0').then((d) => {
      const rows = d.entries.slice(-200);
      const frag = document.createDocumentFragment();
      rows.reverse().forEach((e) => frag.appendChild(streamRow(e)));
      $('stream').appendChild(frag);
    }).catch(() => {});
  }

  function refreshPending() {
    api('/v1/approvals').then((d) => {
      const box = $('pending');
      box.textContent = '';
      $('pendingCount').textContent = d.pending.length;
      if (!d.pending.length) { box.appendChild(el('div', 'empty', 'none')); return; }
      d.pending.forEach((r) => {
        const card = el('div', 'card');
        card.append(el('div', 'card-title', (r.bot || '?') + ' → ' + r.tool));
        card.append(el('div', 'card-reason', r.reason || ''));
        const cd = el('div', 'countdown', '');
        const row = el('div', 'btnrow');
        const ok = el('button', 'btn ok', 'approve');
        const no = el('button', 'btn no', 'deny');
        ok.addEventListener('click', () => resolve(r.id, 'approve', card));
        no.addEventListener('click', () => resolve(r.id, 'deny', card));
        row.append(ok, no);
        card.append(cd, row);
        box.appendChild(card);
        tick(card, cd, r.expiresAt);
      });
    }).catch(() => {});
  }

  function resolve(id, verb, card) {
    api('/v1/approvals/' + id + '/' + verb, { method: 'POST', body: '{}' })
      .then((r) => {
        card.classList.add('done');
        card.querySelector('.btnrow').textContent = r.status || 'done';
        refreshPending();
      })
      .catch((err) => {
        const msg = err.status === 403 ? 'operator token required' : 'failed';
        card.querySelector('.btnrow').textContent = msg;
      });
  }

  const tickers = [];
  function tick(card, cd, expiresAt) {
    const fn = () => {
      if (!document.body.contains(cd)) return;
      const ms = expiresAt - Date.now();
      cd.textContent = ms <= 0 ? 'expired' : 'expires in ' + Math.ceil(ms / 1000) + 's';
    };
    fn(); tickers.push(fn);
  }
  setInterval(() => tickers.forEach((f) => f()), 1000);

  function refreshBots() {
    Promise.all([api('/v2/bots'), api('/v2/stats')]).then(([b, s]) => {
      const box = $('bots');
      box.textContent = '';
      b.bots.forEach((bot) => {
        const row = el('div', 'botrow');
        row.append(el('b', null, bot.name));
        row.append(el('span', 'role ' + (bot.role || 'worker'), bot.role || 'worker'));
        row.append(el('span', 'muted', (s.bots && s.bots[bot.name]) || 0));
        row.append(el('span', 'caps muted', (bot.capabilities || []).join(' ')));
        box.appendChild(row);
      });
    }).catch(() => {});
  }

  function chat(msg) {
    const log = $('chatLog');
    log.appendChild(el('div', 'msg me', msg));
    const bubble = el('div', 'msg bot', '…');
    log.appendChild(bubble);
    api('/v2/chat', { method: 'POST', body: JSON.stringify({ session: sessionId, message: msg }) })
      .then((r) => {
        bubble.textContent = r.reply;
        if (r.actions && r.actions.length) {
          const card = el('div', 'msg action');
          card.append(el('div', null, r.actions[0].tool + ' — ' + r.actions[0].decision));
          if (r.actions[0].approvalId) {
            const ok = el('button', 'btn ok', 'approve');
            ok.addEventListener('click', () => resolve(r.actions[0].approvalId, 'approve', card));
            card.appendChild(ok);
          }
          log.appendChild(card);
        }
        refreshPending();
      })
      .catch((err) => { bubble.textContent = err.status === 404 ? 'chat unavailable' : 'chat error'; });
  }

  $('chatForm').addEventListener('submit', (e) => {
    e.preventDefault();
    const v = $('chatInput').value.trim();
    if (!v) return;
    $('chatInput').value = '';
    chat(v);
  });

  function connect() {
    saveToken();
    if (es) es.close();
    $('liveDot').className = 'dot on';
    api('/v1/audit/verify').then((v) => {
      setPill(v.ok); $('entryCount').textContent = v.length; $('headHash').textContent = String(v.head).slice(0, 12);
      primeStream(); refreshPending(); refreshBots();
    }).catch(() => setPill(false));

    es = new EventSource('/v2/events?token=' + encodeURIComponent(token));
    es.addEventListener('audit', (m) => {
      try {
        const e = JSON.parse(m.data);
        const stream = $('stream');
        stream.prepend(streamRow(e));
        while (stream.children.length > 200) stream.removeChild(stream.lastChild);
        $('entryCount').textContent = e.seq + 1;
        $('headHash').textContent = String(e.hash).slice(0, 12);
        if (e.payload && (e.payload.type === 'approval_requested' || e.payload.type === 'approval_resolved')) refreshPending();
      } catch { /* malformed frame — ignore */ }
    });
    es.onerror = () => { $('liveDot').className = 'dot off'; };
    es.onopen = () => { $('liveDot').className = 'dot on'; };
  }

  $('connectBtn').addEventListener('click', () => { token = tokenEl.value.replace(/•/g, '') || token; connect(); });
  tokenEl.addEventListener('keydown', (e) => { if (e.key === 'Enter') { token = tokenEl.value.replace(/•/g, '') || token; connect(); } });
  if (authed()) connect(); else $('stream').appendChild(el('div', 'empty', 'enter a token to connect'));
})();
