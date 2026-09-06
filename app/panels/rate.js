'use strict';
// Trust Gateway v2 — Rate limits & ledger dashboard panel (FS-M3).
// XSS policy: textContent-only rendering (no element-html APIs).
// §19: near-limit alert history (24h, fra federation-audit) + reaktiv
// SSE-refresh. §20: stream via TG_EVENTS (ticket-exchange — ingen token i
// URL), trailing debounce (400ms) på seal-frames (burst → ét UI-fetch),
// AbortController koblet til re-render (afbryder udestående fetches),
// payload-normalisering i fetch-laget (type-guard — lærdom fra #50).
(function () {
  if (typeof window === 'undefined') return;
  window.TG_PANELS = window.TG_PANELS || [];
  if (window.TG_PANELS.some((p) => p && p.id === 'rate')) return;

  let root = null;
  let refreshTimer = null;
  let debounceTimer = null;
  let abortCtrl = null;
  let unsubscribe = null;

  function el(tag, cls, text) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined) n.textContent = text;
    return n;
  }

  // ── §20 normalisering (fetch-laget, ikke view-helperen): input er rå
  // chain-data (tal ELLER {count}-objekt afhængig af kilde) → altid tal|null.
  function normalizeCount(raw) {
    if (typeof raw === 'number' && Number.isFinite(raw)) return raw;
    if (raw && typeof raw === 'object' && typeof raw.count === 'number' && Number.isFinite(raw.count)) return raw.count;
    return null;
  }

  // normaliserAlertEvent: rå 153-event → stabil række-kontrakt.
  function normalizeAlertEvent(e) {
    const src = (e && (e.data || e.payload)) || {};
    return {
      pattern: (src && typeof src.pattern === 'string') ? src.pattern : ((e && e.type) || '?'),
      count: normalizeCount(src && src.count),
      maxHits: (src && typeof src.maxHits === 'number') ? src.maxHits : null,
      ts: (e && typeof e.ts === 'number') ? e.ts : 0,
    };
  }

  function fmtCount(c) {
    return c === null || c === undefined ? '—' : String(c);
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
      const cnt = el('span', 'tag rate' + (b.nearLimit ? ' rate-near' : ''), fmtCount(b.count));
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

  // View'et modtager KUN normaliserede felter — ingen shape-antagelser.
  function renderAlertRows(events) {
    const frag = document.createDocumentFragment();
    if (!events || !events.length) {
      frag.appendChild(el('div', 'empty', 'No near-limit alerts in the last 24h.'));
      return frag;
    }
    for (const e of events.slice(0, 12)) {
      const row = el('div', 'row');
      const cnt = el('span', 'tag rate-near', fmtCount(e.count));
      const max = el('span', 'tag limit', (e.maxHits === null ? '?' : e.maxHits) + '/s max');
      const at = el('span', 'age', e.ts ? new Date(e.ts).toLocaleTimeString() : '');
      row.append(el('span', 'hash', e.pattern), cnt, max, at);
      frag.appendChild(row);
    }
    return frag;
  }

  function signal() {
    return abortCtrl ? abortCtrl.signal : undefined;
  }

  async function refreshAlerts() {
    if (!root) return;
    const box = root.querySelector('.rate-alerts');
    if (!box) return;
    box.textContent = '';
    const since = Date.now() - 24 * 60 * 60 * 1000;
    try {
      const d = await window.TG.api('/v2/federation/audit/events?type=rate_bucket_near_limit&since=' + since + '&limit=25', { signal: signal() });
      const ev = (d.events || []).map(normalizeAlertEvent);
      box.appendChild(el('div', 'row head', ev.length ? ('⚠ ' + ev.length + ' near-limit alerts (24h)') : 'Near-limit alerts (24h)'));
      box.appendChild(renderAlertRows(ev));
    } catch (e) {
      if (e && e.name === 'AbortError') return; // re-render afbrød — stille
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
      const d = await window.TG.api('/v2/rate/buckets?windowMs=60000', { signal: signal() });
      list.appendChild(el('div', 'row head', 'Live buckets (60s window)'));
      list.appendChild(renderBucketRows(d.buckets || []));
    } catch (e) {
      if (e && e.name === 'AbortError') return;
      list.appendChild(el('div', 'empty', 'buckets: ' + (e && e.message ? e.message : 'unavailable')));
    }
    try {
      const p = await window.TG.api('/v2/rate/limits', { signal: signal() });
      limits.appendChild(el('div', 'row head', 'Route limits'));
      limits.appendChild(renderLimitRows(p.limits || []));
    } catch (e) {
      if (e && e.name === 'AbortError') return;
      limits.appendChild(el('div', 'empty', 'limits: ' + (e && e.message ? e.message : 'unavailable')));
    }
  }

  // §20: trailing debounce — en burst af seal-frames (fx 58 req/s) samles
  // til ÉT UI-fetch efter 400ms stilhed, ikke ét fetch pr. frame.
  function onSealFrame() {
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      debounceTimer = null;
      refreshList();
      refreshAlerts();
    }, 400);
  }

  function apiEnabled() {
    try { return !!(window.TG && window.TG.api); } catch (e) { return false; }
  }

  function render(container) {
    root = container;
    if (refreshTimer) { clearInterval(refreshTimer); refreshTimer = null; }
    if (debounceTimer) { clearTimeout(debounceTimer); debounceTimer = null; }
    if (abortCtrl) { abortCtrl.abort(); abortCtrl = null; }   // afbryd udestående fetches
    if (unsubscribe) { unsubscribe(); unsubscribe = null; }   // afmeld stream fra forrige render

    container.textContent = '';
    const title = el('h3', null, 'Rate limits & buckets');
    container.appendChild(title);
    if (!apiEnabled()) {
      container.appendChild(el('div', 'empty', 'API surface unavailable.'));
      return;
    }
    abortCtrl = new AbortController();

    // §20: stream via fælles TG_EVENTS (ticket — aldrig token i URL).
    if (window.TG_EVENTS && typeof window.TG_EVENTS.open === 'function') {
      window.TG_EVENTS.open();
      unsubscribe = window.TG_EVENTS.onAudit((entry) => {
        const p = (entry && entry.payload) || {};
        if (p.type === 'rate_bucket_near_limit') onSealFrame();
      });
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