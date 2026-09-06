'use strict';
// §20 — Global near-limit alert badge i NOW-stripet (top-prioritet fra
// arkitektur-review): reaktivitet i Rate-panelet hjælper kun når panelet er
// åbent; badge'et gør near-limit-seals synlige fra ETHVERT domæne.
//
// - 24h-tæller ved boot (samme kilde som Rate-panelet: federation-audit).
// - Live-inkrement pr. rate_bucket_near_limit-frame via TG_EVENTS (én delt
//   stream — ingen ekstra EventSource).
// - Klik → åbn Rate-panelet (jumpTab er legacy-kompatibel).
// - textContent-only; skjult når tælleren er 0.
(function () {
  if (typeof window === 'undefined' || !window.TG_EVENTS) return;
  if (window.__TG_ALERT_BADGE__) return;
  window.__TG_ALERT_BADGE__ = true;

  let count = 0;
  let badge = null;
  let countEl = null;
  let unsubAudit = null;
  let unsubAuth = null;
  let busy = false;

  function ensure() {
    if (badge) return;
    const strip = document.getElementById('nowQueue');
    if (!strip) return; // strip bygges af app.js senere — retry ved næste audit
    badge = document.createElement('span');
    badge.className = 'alert-badge';
    badge.title = 'near-limit alerts (24h) — klik for Rate';
    countEl = document.createElement('b');
    badge.appendChild(countEl);
    badge.appendChild(document.createTextNode(' near-limit'));
    badge.addEventListener('click', () => {
      // jumpTab er en closure i app.js (ikke global) — TG_CORE.switchTab er
      // den støttede vej (core.js, panel-id → domæne-opløsning).
      const core = window.TG_CORE;
      if (core && typeof core.switchTab === 'function') {
        try { core.switchTab('rate'); } catch (e) { /* tab-router utilgængelig */ }
      }
    });
    strip.appendChild(badge);
    sync();
  }

  function sync() {
    if (!badge) return;
    badge.classList.toggle('hidden', count === 0);
    if (countEl) countEl.textContent = String(count);
  }

  async function bootCount() {
    if (busy || !window.TG || !window.TG.api) return;
    busy = true;
    try {
      const since = Date.now() - 24 * 60 * 60 * 1000;
      const d = await window.TG.api('/v2/federation/audit/events?type=rate_bucket_near_limit&since=' + since + '&limit=1');
      if (d && typeof d.total === 'number') { count = d.total; sync(); }
    } catch (e) { /* badge fejler aldrig hårde: silent */ }
    busy = false;
  }

  function onAudit(entry) {
    const p = (entry && entry.payload) || {};
    if (p.type === 'rate_bucket_near_limit') {
      ensure();
      count += 1;
      sync();
    }
  }

  // Boot: stream + badge. app.js åbner TG_EVENTS ved connect; vi abonnerer
  // nu, så eventuelle tidlige frames ikke tabes.
  unsubAudit = window.TG_EVENTS.onAudit(onAudit);
  unsubAuth = window.TG_EVENTS.onAuthExpired(() => {
    if (badge) badge.classList.add('hidden'); // auth væk — skjul, tilføj ikke
  });
  window.TG_EVENTS.open();
  ensure();
  bootCount();
  // strip bygges muligvis EFTER os (app.js connect-flow) — poll kortholdt.
  setTimeout(ensure, 800);
  setTimeout(ensure, 2500);
})();