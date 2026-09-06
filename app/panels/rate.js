'use strict';
// Trust Gateway v2 — Rate limits & ledger dashboard panel (FS-M3).
// XSS policy: textContent-only rendering (no element-html APIs).
// §19: near-limit alert history (24h, from the federation audit dashboard) +
// reactive SSE refresh — a rate_bucket_near_limit frame refreshes the panel
// immediately instead of waiting up to 30s for the poll tick.
(function () {
  if (typeof window === 'undefined') return;
  window.TG_PANELS = window.TG_PANELS || [];
  if (window.TG_PANELS.some((p) => p && p.id === 'rate')) return;

  let root = null;
  let refreshTimer = null;
  let es = null;

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
      const cnt = el('span', 'tag rate' + (b.nearLimit ? ' rate-near' : ''), fmtCount(b));
      const w = el('span', 'age', (b.windowMs || 0) / 1000 + 's window');
      const at = el('span', 'age', b.updatedAt ? new Date(b.updatedAt).toLocaleTimeString() : '');
      if (b.nearLimit) at.textContent = ' ⚠ near-limit (' + (b.maxHits || '?') + '/s max)';
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

  function renderAlertRows(events) {
    const frag = document.createDocumentFragment();
    if (!events || !events.length) {
      frag.appendChild(el('div', 'empty', 'No near-limit alerts in the last 24h.'));
      return frag;
    }
    for (const e of events.slice(0, 12)) {
      const row = el('div', 'row');
      const d = (e.payload && e.payload.pattern) || (e.data && e.data.pattern) || e.type || '?';
      const cnt = el('span', 'tag rate-near', fmtCount((e.payload || e.data || {}).count));
      const max = el('span', 'tag limit', String((e.payload || e.data || {}).maxHits || '?') + '/s max');
      const at = el('span', 'age', e.ts ? new Date(e.ts).toLocaleTimeString() : '');
      row.append(el('span', 'hash', d), cnt, max, at);
      frag.appendChild(row);
    }
    return frag;
  }

  function eventPayload(e) {
    // chain entry: {payload:{type,...}} — SSE frames carry the same entry
    return (e && e.payload) || {};
  }

  async function refreshAlerts() {
    if (!root) return;
    const box = root.querySelector('.rate-alerts');
    if (!box) return;
    box.textContent = '';
    const since = Date.now() - 24 * 60 * 60 * 1000;
    try {
      const d = await window.TG.api('/v2/federation/audit/events?type=rate_bucket_near_limit&since=' + since + '&limit=25');
      const ev = d.events || [];
      box.appendChild(el('div', 'row head', ev.length ? ('⚠ ' + ev.length + ' near-limit alerts (24h)') : 'Near-limit alerts (24h)'));
      box.appendChild(renderAlertRows(ev));
    } catch (e) {
      box.appendChild(el('div', 'empty', 'alerts: ' + (e && e.message ? e.message : 'unavailable')));
    }
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

  function openStream() {
    if (es) { es.close(); es = null; }
    let tok = '';
    try { tok = window.TG && typeof window.TG.token === 'function' ? window.TG.token() : ''; } catch (e) { tok = ''; }
    if (!tok) return;
    try {
      es = new EventSource('/v2/events?token=' + encodeURIComponent(tok));
      es.addEventListener('audit', (ev) => {
        let entry = null;
        try { entry = JSON.parse(ev.data); } catch (e) { return; }
        const p = eventPayload(entry);
        if (p && p.type === 'rate_bucket_near_limit') {
          refreshList();
          refreshAlerts();
        }
      });
    } catch (e) { es = null; }
  }

  function apiEnabled() {
    try { return !!(window.TG && window.TG.api); } catch (e) { return false; }
  }

  function render(container) {
    root = container;
    if (refreshTimer) { clearInterval(refreshTimer); refreshTimer = null; }
    openStream();

    container.textContent = '';
    const title = el('h3', null, 'Rate limits & buckets');
    container.appendChild(title);
    if (!apiEnabled()) {
      container.appendChild(el('div', 'empty', 'API surface unavailable.'));
      if (es) { es.close(); es = null; }
      return;
    }
    container.appendChild(el('div', 'rate-alerts'));
    container.appendChild(el('div', 'rate-buckets'));
    container.appendChild(el('div', 'rate-limits'));
    const refresh = el('button', undefined, 'Refresh');
    refresh.addEventListener('click', () => { refreshList(); refreshAlerts(); });
    container.appendChild(refresh);

    refreshList();
    refreshAlerts();
    refreshTimer = setInterval(() => { refreshList(); refreshAlerts(); }, 30000);
  }

  window.TG_PANELS.push({ id: 'rate', title: 'Rate', render });
})();