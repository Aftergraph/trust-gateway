'use strict';
// Trust Gateway v2 — History audit browser panel.
// Registers itself in window.TG_PANELS so core.js can lazy-mount it.
// XSS policy: textContent only, no innerHTML.
(function () {
  if (typeof window === 'undefined') return;
  window.TG_PANELS = window.TG_PANELS || [];
  if (window.TG_PANELS.some((p) => p && p.id === 'history')) return;

  const LIMIT = 500;
  let currentType = 'all';
  let currentBot = '';
  let oldestSeq = null;
  let livePrepend = false;

  // Mutable UI refs (assigned in render).
  let listEl = null, modal = null, detailBody = null;
  let searchInput = null, typeSelect = null, botInput = null;
  let loadOlder = null;

  function el(tag, cls, text) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined) n.textContent = text;
    return n;
  }

  function fetchAudit(since) {
    const num = typeof since === 'number' && since > 0 ? since : 0;
    return window.TG.api('/v1/audit?since=' + num).then((d) => d.entries || []);
  }

  function fetchSearch(q) {
    return window.TG.api('/v2/search?q=' + encodeURIComponent(q)).then((d) => d.hits || []);
  }

  function matchesFilters(e) {
    const p = e.payload || {};
    if (currentType !== 'all' && p.type !== currentType) return false;
    if (currentBot && !(p.bot && p.bot.indexOf(currentBot) === 0)) return false;
    return true;
  }

  function renderRows(entries) {
    const frag = document.createDocumentFragment();
    for (const e of entries) {
      const row = el('div', 'row', '');
      const seq = el('span', 'hash', '#' + e.seq);
      const ts = el('span', 'age', new Date(e.ts).toLocaleTimeString());
      const p = e.payload || {};
      const type = el('span', 'tag ' + (p.type ? p.type : 'other'), p.type || '');
      const bot = el('span', 'who', p.bot || p.approver || '');
      const tool = el('span', 'tool', p.tool || '');
      row.append(seq, ts, type, bot, tool);
      row.addEventListener('click', () => showDetail(e));
      frag.appendChild(row);
    }
    return frag;
  }

  function clearList() { listEl.textContent = ''; }

  function setRows(entries) {
    clearList();
    listEl.appendChild(renderRows(entries));
    recomputeOldest();
  }

  function appendRows(entries) {
    listEl.appendChild(renderRows(entries));
    recomputeOldest();
  }

  function recomputeOldest() {
    const rows = listEl ? listEl.querySelectorAll('.row') : [];
    let min = Infinity;
    for (const r of rows) {
      const m = String(r.firstChild && r.firstChild.textContent || '').match(/#(\d+)/);
      if (m && Number(m[1]) < min) min = Number(m[1]);
    }
    oldestSeq = min === Infinity ? null : min;
    if (loadOlder) loadOlder.disabled = !oldestSeq;
  }

  function doLoadOlder() {
    if (oldestSeq == null) return;
    fetchAudit(oldestSeq).then((entries) => {
      const filtered = entries.filter(matchesFilters);
      if (filtered.length) appendRows(filtered);
    }).catch(() => {});
  }

  function refresh() {
    if (!listEl || !searchInput) return;
    const q = searchInput.value.trim();
    if (loadOlder) loadOlder.disabled = true;
    oldestSeq = null;

    const onSuccess = (entries) => {
      const filtered = q ? entries : entries.filter(matchesFilters);
      // Cap at LIMIT rows.
      if (filtered.length > LIMIT) {
        filtered.splice(LIMIT);
        if (loadOlder) loadOlder.disabled = false;
        // Recompute oldest from the capped set.
      }
      setRows(filtered);
      // Populate type filter from returned payloads.
      populateTypes(entries);
    };

    if (q) {
      fetchSearch(q).then(onSuccess).catch(() => setRows([]));
    } else {
      fetchAudit().then(onSuccess).catch(() => setRows([]));
    }
  }

  function populateTypes(entries) {
    if (!typeSelect) return;
    const existing = [];
    for (const o of typeSelect.options) existing.push(o.value);
    const seen = {};
    for (const e of entries) {
      const t = (e.payload && e.payload.type) || '';
      if (t && !seen[t]) { seen[t] = true; }
    }
    for (const t in seen) {
      if (existing.indexOf(t) === -1) {
        const o = el('option', null, t);
        o.value = t;
        typeSelect.appendChild(o);
      }
    }
  }

  function showDetail(entry) {
    if (!modal || !detailBody) return;
    detailBody.textContent = JSON.stringify(entry.payload || entry, null, 2);
    modal.classList.add('view-show');
  }

  // Phase 1 (§18.3): chain-seq jump — land on a specific audit seq (from the
  // ⌘K palette). Mounts History if needed, loads a window around the seq,
  // renders it, and highlights + opens the target row.
  function jumpToSeq(seq) {
    seq = Number(seq);
    if (!Number.isFinite(seq) || seq < 0) return;
    if (window.TG_CORE && typeof window.TG_CORE.switchTab === 'function') {
      window.TG_CORE.switchTab('history');
    }
    const since = Math.max(0, seq - 40);
    fetchAudit(since).then((entries) => {
      const windowed = entries.filter((e) => e.seq >= since && e.seq <= seq + 20);
      if (searchInput) searchInput.value = '';
      setRows(windowed);
      const rows = listEl ? listEl.querySelectorAll('.row') : [];
      for (const r of rows) {
        const m = String(r.firstChild && r.firstChild.textContent || '').match(/#(\d+)/);
        if (m && Number(m[1]) === seq) {
          r.classList.add('hist-jump');
          r.scrollIntoView({ behavior: 'smooth', block: 'center' });
          const idx = Array.prototype.indexOf.call(rows, r);
          const e = windowed[idx];
          if (e) showDetail(e);
          break;
        }
      }
    }).catch(() => {});
  }

  function closeDetail() {
    if (modal) modal.classList.remove('view-show');
  }

  function render(host) {
    // Header controls.
    const header = el('div', 'hist-header', '');
    searchInput = el('input', 'hist-search', '');
    searchInput.type = 'text';
    searchInput.placeholder = 'search audit';
    searchInput.addEventListener('input', () => refresh());
    searchInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') refresh(); });

    typeSelect = el('select', 'hist-type', '');
    const allOpt = el('option', null, 'all types');
    allOpt.value = 'all';
    typeSelect.appendChild(allOpt);
    typeSelect.addEventListener('change', () => { currentType = typeSelect.value; refresh(); });

    botInput = el('input', 'hist-bot', '');
    botInput.type = 'text';
    botInput.placeholder = 'bot name';
    botInput.addEventListener('input', () => { currentBot = botInput.value.trim(); refresh(); });
    botInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') refresh(); });

    header.append(searchInput, typeSelect, botInput);

    // Results list.
    listEl = el('div', 'hist-list', '');

    // Load older.
    loadOlder = el('button', 'btn', 'load older');
    loadOlder.id = 'loadOlder';
    loadOlder.disabled = true;
    loadOlder.addEventListener('click', doLoadOlder);

    // Detail overlay (div.modal).
    modal = el('div', 'modal', '');
    modal.id = 'histModal';
    detailBody = el('pre', 'hist-detail', '');
    const close = el('button', 'btn', 'close');
    close.addEventListener('click', closeDetail);
    modal.append(detailBody, close);

    host.append(header, listEl, loadOlder, modal);

    // Live prepend while visible.
    if (window.TG && typeof window.TG.onAudit === 'function') {
      window.TG.onAudit((entry) => {
        if (!livePrepend || !listEl) return;
        if (!matchesFilters(entry)) return;
        const frag = renderRows([entry]);
        listEl.insertBefore(frag.firstChild, listEl.firstChild);
        recomputeOldest();
      });
    }

    livePrepend = true;
    refresh();
  }

  window.TG_PANELS = window.TG_PANELS || [];
  if (!window.TG_PANELS.some((p) => p && p.id === 'history')) {
    window.TG_PANELS.push({ id: 'history', title: 'History', render });
  }
  // Expose internals for tests.
  window.TG_HISTORY = {
    matchesFilters, fetchSearch, fetchAudit, LIMIT,
    setFilters: (t, b) => { currentType = t; currentBot = b; },
    jumpToSeq,
  };
})();
