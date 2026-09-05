'use strict';
// Trust Gateway v2 — Rate limits & ledger dashboard panel (FS-M3).
// Shows route-limit policy + live current-window bucket counts, operator-only.
// XSS policy: textContent only, no innerHTML.
(function () {
  if (typeof window === 'undefined') return;
  window.TG_PANELS = window.TG_PANELS || [];
  if (window.TG_PANELS.some((p) => p && p.id === 'rate')) return;

  let root = null;
  let refreshTimer = null;

  function el(tag, cls, text) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined) n.textContent = text;
    return n;
  }

  function fmtCount(k) {
    return k.count === undefined ? '—' : String(k.count);
  }

  function renderBucketRows(buckets) {
    const frag = document.createDocumentFragment();
    if (!buckets || !buckets.length) {
      frag.appendChild(el('div', 'empty', 'No current-window buckets yet.'));
      return frag;
    }
    for (const b of buckets) {
      const row = el('div', 'row');
      const key = el('span', 'hash', b.key || '?');
      const cnt = el('span', 'tag rate', fmtCount(b));
      const w = el('span', 'age', (b.windowMs || 0) / 1000 + 's window');
      const at = el('span', 'age', b.updatedAt ? new Date(b.updatedAt).toLocaleTimeString() : '');
      row.append(key, cnt, w, at);
      frag.appendChild(row);
    }
    return frag;
  }

  function renderLimitRows(limits) {
    const frag = document.createDocumentFragment();
    if (!limits || !limits.length) {
      frag.appendChild(el('div', 'empty', 'No route limits configured.'));
      return frag;
    }
    for (const l of limits) {
      const row = el('div', 'row');
      const pattern = el('span', 'hash', l.pattern || '?');
      const max = el('span', 'tag limit', String(l.maxHits) + '/s');
      const win = el('span', 'age', String(Math.round((l.windowMs || 0) / 1000)) + 's');
      row.append(pattern, max, win);
      frag.appendChild(row);
    }
    return frag;
  }

  async function refreshList() {
    if (!root) return;
    const list = root.querySelector('.rate-buckets');
    const limits = root.querySelector('.rate-limits');
    if (!list || !limits) return;
    list.textContent = '';
    limits.textContent = '';
    try {
      const d = await window.TG.api('/v2/rate/buckets?windowMs=60000');
      list.appendChild(el('div', 'row head', 'Live buckets (60s window)'));
      list.appendChild(renderBucketRows(d.buckets || []));
    } catch (e) {
      list.appendChild(el('div', 'empty', 'buckets: ' + (e && e.message ? e.message : 'unavailable')));
    }
    try {
      const p = await window.TG.api('/v2/rate/limits');
      limits.appendChild(el('div', 'row head', 'Route limits'));
      limits.appendChild(renderLimitRows(p.limits || []));
    } catch (e) {
      limits.appendChild(el('div', 'empty', 'limits: ' + (e && e.message ? e.message : 'unavailable')));
    }
  }

  function apiEnabled() {
    try { return !!(window.TG && window.TG.api); } catch (e) { return false; }
  }

  function render(container) {
    root = container;
    if (refreshTimer) { clearInterval(refreshTimer); refreshTimer = null; }

    container.textContent = '';
    const title = el('h3', null, 'Rate limits & buckets');
    container.appendChild(title);
    if (!apiEnabled()) {
      container.appendChild(el('div', 'empty', 'API surface unavailable.'));
      return;
    }
    container.appendChild(el('div', 'rate-buckets'));
    container.appendChild(el('div', 'rate-limits'));
    const refresh = el('button', undefined, 'Refresh');
    refresh.addEventListener('click', () => refreshList());
    container.appendChild(refresh);

    refreshList();
    refreshTimer = setInterval(() => refreshList(), 30000);
  }

  window.TG_PANELS.push({ id: 'rate', title: 'Rate', render });
})();