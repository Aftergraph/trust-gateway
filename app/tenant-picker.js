'use strict';
// FS-A1 slice 3 — tenant picker for the operator console.
// Loads after auth.js. Fetches GET /v2/tenants/accessible (operator-gated);
// renders a <select> next to the auth chip. The chosen tenant id is stored
// in localStorage (tg_tenant — scope selection, NOT a secret) and attached
// as an X-Tenant header on every operator API call via TG.tenantHeader().

(function () {
  function bearerToken() {
    try { return (window.TG && typeof window.TG.token === 'function') ? (window.TG.token() || '') : ''; }
    catch (e) { return ''; }
  }

  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined) n.textContent = text;
    return n;
  }

  var picker = null;

  function fetchAccessible() {
    return fetch('/v2/tenants/accessible', {
      headers: { authorization: 'Bearer ' + bearerToken() },
    }).then(function (res) {
      if (!res.ok) return null;
      return res.json();
    }).catch(function () { return null; });
  }

  function renderPicker(tenants) {
    var slot = document.getElementById('tenantPicker');
    if (!slot) return;
    slot.textContent = '';
    if (!tenants || !tenants.length) return; // worker token / endpoint disabled
    var sel = el('select', 'tenant-select');
    sel.id = 'tenantSelect';
    var saved = null;
    try { saved = localStorage.getItem('tg_tenant'); } catch (e) { saved = null; }
    var found = false;
    tenants.forEach(function (t) {
      var o = el('option', null, t.name + (t.disabled ? ' (disabled)' : ''));
      o.value = t.id;
      sel.appendChild(o);
      if (t.id === saved) found = true;
    });
    if (found) sel.value = saved;
    sel.addEventListener('change', function () {
      try { localStorage.setItem('tg_tenant', sel.value); } catch (e) { /* private mode */ }
      window.dispatchEvent(new CustomEvent('tg-tenant-changed', { detail: { tenant: sel.value } }));
    });
    picker = sel;
    slot.appendChild(sel);
  }

  function refresh() {
    fetchAccessible().then(renderPicker);
  }

  // Re-fetch when auth state changes (token set/cleared)
  window.addEventListener('tg-auth-changed', refresh);

  // Public hook: current tenant id or '' (main default)
  window.TGTenant = {
    current: function () {
      try { return localStorage.getItem('tg_tenant') || ''; } catch (e) { return ''; }
    },
    header: function () {
      var t = this.current();
      return t ? { 'x-tenant': t } : {};
    },
    refresh: refresh,
  };

  // Boot after auth resolves its state (auth.js listens on the same cycle)
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', refresh);
  } else {
    refresh();
  }
})();