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
  let whoami = null;  // identity name from GET /v2/whoami (phase 3)
  let myCaps = [];    // capabilities of whoami (phase 3 composition input)
  let myScopes = {};  // G6: capability-scoped API surface (phase 4)
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
      // Phase 3: remember this identity's capabilities for the composition
      // engine (the bot matching our token's name; '*' passes through).
      const mine = (b.bots || []).find((x) => x.name === whoami);
      myCaps = mine && Array.isArray(mine.capabilities) ? mine.capabilities : [];
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

  // ── Phase 4 (G6): capability-scoped API surface ──────────────────────
  // Extensions MUST NOT call fetch() directly with the operator token
  // (§19.2). TG.api.scope(requiredCaps) returns a fetch-like wrapper that
  // refuses verbs outside the identity's grants BEFORE any request leaves
  // the page. Route → required-capability map mirrors server-side policy;
  // '*' grants everything. Grant state is the whoami projection — never
  // guessed, never mutated by panels.
  const ROUTE_CAPS = [
    { re: /^\/v1\/approvals\/[^/]+\/(approve|deny)$/, cap: 'approval.decide' },
    { re: /^\/v2\/plugins(\/|$)/, method: 'GET', cap: null },
    { re: /^\/v2\/plugins/, cap: 'plugin.install' },
    { re: /^\/v2\/adapters\/kinds$/, method: 'GET', cap: null },
    { re: /^\/v2\/adapters/, cap: 'adapter.manage' },
    { re: /^\/v2\/memory/, method: 'GET', cap: null },
    { re: /^\/v2\/memory/, cap: 'memory.write' },
    { re: /^\/v2\/runs\/[^/]+\/cancel$/, cap: 'control.take' },
    { re: /^\/v2\/runs/, method: 'GET', cap: null },
    { re: /^\/v1\/actions$/, cap: 'action.run' },
    { re: /^\/v2\/computer/, cap: 'control.take' },
    { re: /^\/v2\/goals/, cap: 'goal.create' },
    { re: /^\/v2\/providers/, cap: 'provider.select' },
  ];
  function requiredCap(path, method) {
    for (const r of ROUTE_CAPS) {
      if (r.re.test(path)) {
        if (r.cap === null) return null; // explicitly read-only route
        if (r.method && r.method !== method) continue;
        return r.cap;
      }
    }
    return null; // unmapped routes: allowed (server RBAC still enforces)
  }
  function buildScopes(caps) {
    const granted = caps.indexOf('*') !== -1;
    const has = (c) => granted || caps.indexOf(c) !== -1;
    return {
      can: (cap) => has(cap),
      // fetch-like wrapper: (path, opts) → Promise<Response-like>
      fetch: function (path, opts) {
        const method = ((opts && opts.method) || 'GET').toUpperCase();
        const need = requiredCap(String(path), method);
        if (need && !has(need)) {
          return Promise.reject(Object.assign(new Error('capability_missing:' + need), { capabilityMissing: need, status: 403 }));
        }
        return api(path, opts);
      },
    };
  }

  function connect() {
    saveToken();
    if (es) es.close();
    $('liveDot').className = 'dot on';
    // Phase 3: resolve identity before the composition inputs are read.
    // Phase 4 (G6): capability-scoped API surface — the console binds the
    // identity's capability grants; extension panels call TG.api.scope()
    // and get fetch wrappers that refuse verbs beyond the grants.
    api('/v2/whoami').then((w) => {
      whoami = w.name;
      myCaps = w.capabilities || [];
      myScopes = buildScopes(myCaps);
    }).catch(() => { whoami = null; myCaps = []; myScopes = buildScopes([]); });
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
        window.dispatchEvent(new CustomEvent('tg-audit', { detail: e })); // fan-out to panels
      } catch { /* malformed frame — ignore */ }
    });
    es.onerror = () => { $('liveDot').className = 'dot off'; };
    es.onopen = () => { $('liveDot').className = 'dot on'; };
  }

  $('connectBtn').addEventListener('click', () => { token = tokenEl.value.replace(/•/g, '') || token; connect(); });
  tokenEl.addEventListener('keydown', (e) => { if (e.key === 'Enter') { token = tokenEl.value.replace(/•/g, '') || token; connect(); } });
  if (authed()) connect(); else $('stream').appendChild(el('div', 'empty', 'enter a token to connect'));

  // ── Phase 1 (§20): NOW queue strip — pending approvals visible from EVERY
  // tab without navigating. Renders the same store as the Console pane; the
  // strip is a summary + jump affordance, not a second decision surface.
  let stripCount = null;
  function ensureStrip() {
    if (document.getElementById('nowQueue')) return;
    const strip = el('div', 'now-queue');
    strip.id = 'nowQueue';
    const label = el('span', 'now-queue-label', 'NOW · pending');
    stripCount = el('b', 'now-queue-count', '0');
    const open = el('button', 'btn now-queue-open', 'open queue');
    open.addEventListener('click', () => {
      jumpTab('console');
      const pending = document.getElementById('pending');
      if (pending) pending.scrollIntoView({ behavior: 'smooth', block: 'center' });
    });
    strip.append(label, stripCount, open);
    const header = document.querySelector('header');
    if (header) header.appendChild(strip);
  }
  let lastStripN = null;
  function refreshStrip() {
    if (!stripCount) return;
    const n = Number(document.getElementById('pendingCount') && document.getElementById('pendingCount').textContent) || 0;
    const changed = lastStripN !== null && lastStripN !== n; // FE2: pulse only on real count changes
    lastStripN = n;
    stripCount.textContent = n;
    const strip = document.getElementById('nowQueue');
    if (strip) {
      strip.classList.toggle('has-pending', n > 0);
      if (changed) pulseStrip(strip);
    }
  }
  // FE2 (craft): one-shot pulse when the pending count moves. Removing the
  // class on animationend re-arms it for the next change; the reflow forces
  // a restart when a previous pulse is still mid-flight.
  function pulseStrip(strip) {
    strip.classList.remove('just-changed');
    void strip.offsetWidth;
    strip.classList.add('just-changed');
    strip.addEventListener('animationend', () => strip.classList.remove('just-changed'), { once: true });
  }

  // ── Phase 1 (§18.1): palette (⌘K / Ctrl+K) — one input, context-aware:
  // audit search (GET /v2/search, primary channel) + tab jumps. Enter on a
  // result jumps History to that seq (§18.3 chain-seq jump).
  const PALETTE_COMMANDS = [
    { label: 'Console (NOW)', run: () => jumpTab('console') },
    { label: 'History (search & audit)', run: () => jumpTab('history') },
    { label: 'Rooms', run: () => jumpTab('rooms') },
    { label: 'Artifacts', run: () => jumpTab('artifacts') },
    { label: 'Goals', run: () => jumpTab('goals') },
    { label: 'Live providers', run: () => jumpTab('providers-live') },
    { label: 'Refresh', run: () => { primeStream(); refreshPending(); refreshBots(); } },
  ];
  function jumpTab(id) {
    const core = window.TG_CORE;
    if (core && typeof core.switchTab === 'function') {
      try { core.switchTab(id); } catch { /* noop */ }
    }
  }
  let paletteEl = null;
  function ensurePalette() {
    if (paletteEl) return paletteEl;
    const wrap = el('div', 'modal palette-modal');
    wrap.id = 'palette';
    const box = el('div', 'palette-box');
    const input = el('input', 'palette-input', '');
    input.type = 'text';
    input.placeholder = 'search audit · jump to tab… (Enter to open top result, ↑↓ select, Esc close)';
    const list = el('div', 'palette-results');
    box.append(input, list);
    wrap.append(box);
    document.body.appendChild(wrap);
    paletteEl = { wrap, input, list };

    let lastResults = [];
    let selected = 0;

    function render() {
      list.textContent = '';
      lastResults.slice(0, 12).forEach((r, i) => {
        const row = el('div', 'palette-row' + (i === selected ? ' sel' : ''));
        row.append(el('span', 'palette-row-label', r.label));
        if (r.meta) row.append(el('span', 'palette-row-meta', r.meta));
        row.addEventListener('click', () => r.run());
        list.appendChild(row);
      });
    }
    function update() {
      const q = input.value.trim();
      const cmds = PALETTE_COMMANDS
        .filter((c) => !q || c.label.toLowerCase().includes(q.toLowerCase()))
        .map((c) => ({ label: c.label, kind: 'command', meta: 'jump', run: () => { close(); c.run(); } }));
      if (!q) {
        lastResults = cmds; selected = 0; render(); return;
      }
      // ── G3 (§18.5): fuzzy object-id resolution ─────────────────────────
      // 18.5.1 — bare integer resolves to the audit entry at that chain seq.
      const SEQ_ID_RE = /^\d+$/;
      // 18.5.2 — 8-hex transparency token (same regex as mounts/90-transparency.js);
      // optional sess_ prefix. Format-validated client-side ONLY: the palette
      // never probes /h for existence — unknown token and missing session are
      // byte-identical 404s server-side, and the client must not distinguish.
      const TOKEN_ID_RE = /^(sess_)?[0-9a-f]{8}$/;
      // 18.5 fuzzy ladder on zero hits: retry last word, then its first 4 chars.
      function fuzzyQueries(query) {
        const words = query.split(/\s+/).filter(Boolean);
        const last = words[words.length - 1];
        if (!last) return [];
        const ladder = [last];
        if (last.length > 4) ladder.push(last.slice(0, 4));
        return ladder.filter((s) => s.toLowerCase() !== query.toLowerCase());
      }
      const idRows = [];
      if (SEQ_ID_RE.test(q)) {
        idRows.push({
          label: 'jump to seq ' + q, kind: 'id', meta: 'seq',
          run: () => { close(); jumpToSeq(Number(q)); },
        });
      }
      if (TOKEN_ID_RE.test(q)) {
        // /h expects the bare 8-hex token (mounts/90-transparency.js TOKEN_RE),
        // so a sess_-prefixed input sheds the prefix for the URL. Navigate
        // unconditionally — the client never probes for existence.
        const hex = q.replace(/^sess_/, '');
        idRows.push({
          label: 'open transcript /h/' + hex, kind: 'id', meta: 'transcript',
          run: () => { close(); location.assign('/h/' + hex); },
        });
      }
      // audit search as primary channel (§18: palette search → /v2/search);
      // G3: on zero hits walk the fuzzy ladder, marking retried rows 'fuzzy'.
      const runSearch = (query, rest, fuzzy) => window.TG.api('/v2/search?q=' + encodeURIComponent(query) + '&limit=8').then((d) => {
        const hits = (d.hits || []).map((h) => ({
          label: (h.payload && h.payload.type ? h.payload.type : 'entry') + '  #' + h.seq,
          kind: 'hit',
          meta: ((h.payload && (h.payload.bot || h.payload.tool)) || '') + (fuzzy ? ' fuzzy' : ''),
          run: () => { close(); jumpToSeq(h.seq); },
        }));
        if (!hits.length && rest.length) return runSearch(rest[0], rest.slice(1), true);
        lastResults = idRows.concat(hits, cmds); selected = 0; render();
      }).catch(() => { lastResults = idRows.concat(cmds); selected = 0; render(); });
      runSearch(q, fuzzyQueries(q), false);
    }
    input.addEventListener('input', update);
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') { close(); e.preventDefault(); return; }
      if (e.key === 'ArrowDown') { selected = Math.min(selected + 1, lastResults.length - 1); render(); e.preventDefault(); return; }
      if (e.key === 'ArrowUp') { selected = Math.max(selected - 1, 0); render(); e.preventDefault(); return; }
      if (e.key === 'Enter') { const r = lastResults[selected]; close(); if (r) r.run(); e.preventDefault(); return; }
    });
    wrap.addEventListener('click', (e) => { if (e.target === wrap) close(); });
    return paletteEl;
  }
  function openPalette() {
    const p = ensurePalette();
    p.wrap.classList.add('view-show');
    p.input.value = '';
    p.input.focus();
  }
  function close() { if (paletteEl) paletteEl.wrap.classList.remove('view-show'); }
  document.addEventListener('keydown', (e) => {
    if ((e.metaKey || e.ctrlKey) && (e.key === 'k' || e.key === 'K')) { e.preventDefault(); openPalette(); }
  });

  function jumpToSeq(seq) {
    const h = window.TG_HISTORY;
    if (h && typeof h.jumpToSeq === 'function') { h.jumpToSeq(seq); return; }
    jumpTab('history');
  }

  ensureStrip();
  setInterval(refreshStrip, 1500);

  // shared surface for /panels/*.js (wave B UI modules)
  window.TG = {
    api, el,
    token: () => token,
    authed,
    // phase 3 composition inputs (§5.1): the engine reads permissions from
    // here; empty until the identity resolves (never guesses ['*']).
    capabilities: () => myCaps,
    whoami: () => whoami,
    // phase 4 (G6): capability-scoped API for extension panels.
    // TG.api.scope(['goal.create']) → {fetch, can} bound to the identity.
    scope: (requiredCaps) => {
      const need = Array.isArray(requiredCaps) ? requiredCaps : [];
      const missing = need.filter((c) => !myScopes.can || !myScopes.can(c));
      if (missing.length) {
        return { ok: false, missing, fetch: () => Promise.reject(Object.assign(new Error('capability_missing:' + missing.join(',')), { capabilityMissing: missing, status: 403 })), can: () => false };
      }
      return Object.assign({ ok: true, missing: [] }, myScopes);
    },
    refresh: () => { refreshPending(); refreshBots(); },
    onAudit: (fn) => { window.addEventListener('tg-audit', (ev) => fn(ev.detail)); },
  };
})();
