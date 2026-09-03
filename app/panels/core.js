'use strict';
// Trust Gateway v2 — Core tab router.
// Builds the #tabs nav, lazy-mounts registered TG_PANELS into <main>'s parent,
// hides the original 3-pane <main class="panes"> via the view-hide class.
// XSS policy: textContent only, no innerHTML. Idempotent + defensive against
// TG_PANELS being empty or growing later (rescan on each tab switch).
(function () {
  // Ordered tab spec. 'console' is the original 3-pane grid.
  const TABS = [
    { id: 'console', title: 'Console' },
    { id: 'rooms', title: 'Rooms' },
    { id: 'artifacts', title: 'Artifacts' },
    { id: 'goals', title: 'Goals' },
    { id: 'builder', title: 'Builder' },
    { id: 'hub', title: 'Hub' },
    { id: 'providers', title: 'Providers' },
    { id: 'providers-live', title: 'Live' },
    { id: 'history', title: 'History' },
    { id: 'computer', title: 'Computer' },
    { id: 'playground', title: 'Playground' },
    { id: 'voice', title: 'Voice' },
    { id: 'integrations', title: 'Integrations' },
  ];

  const TAB_IDS = TABS.map((t) => t.id);

  function ready(fn) {
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', fn);
    else fn();
  }

  function scanPanels() {
    const list = window.TG_PANELS;
    if (!Array.isArray(list)) return [];
    const out = [];
    for (const p of list) {
      if (p && typeof p.id === 'string' && typeof p.render === 'function' && out.indexOf(p) === -1) out.push(p);
    }
    return out;
  }

  function getMain() {
    return document.querySelector('main.panes') || document.querySelector('main');
  }

  function ensureShell() {
    const nav = document.getElementById('tabs');
    if (!nav) return null;
    const main = getMain();
    if (!main) return null;
    const parent = main.parentNode;
    let host = document.getElementById('panel-host');
    if (!host) {
      host = document.createElement('section');
      host.id = 'panel-host';
      host.className = 'panel-host';
      parent.insertBefore(host, main);
    }
    return { nav, main, host, parent };
  }

  function buildTabs(shell) {
    const { nav } = shell;
    // Avoid duplicate buttons if re-run.
    while (nav.firstChild) nav.removeChild(nav.firstChild);
    for (const t of TABS) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'tab';
      btn.dataset.tab = t.id;
      btn.textContent = t.title;
      btn.addEventListener('click', () => switchTab(shell, t.id));
      nav.appendChild(btn);
    }
  }

  function mountPanel(id) {
    const panels = scanPanels();
    const found = panels.find((p) => p.id === id);
    if (!found) return false;
    const section = document.getElementById('pv-' + id);
    if (section) return true; // already mounted (idempotent)
    const host = document.getElementById('panel-host');
    if (!host) return false;
    const sec = document.createElement('section');
    sec.className = 'panel-view';
    sec.id = 'pv-' + id;
    host.appendChild(sec);
    try {
      found.render(sec);
    } catch (e) {
      console.error('panel render error [' + id + ']:', e);
    }
    return true;
  }

  function showPlaceholder(host, id) {
    // Unknown / not-yet-loaded panel id → placeholder.
    let ph = document.getElementById('pv-' + id);
    if (ph) return;
    ph = document.createElement('section');
    ph.className = 'panel-view panel-placeholder';
    ph.id = 'pv-' + id;
    const msg = document.createElement('div');
    msg.className = 'empty';
    msg.textContent = 'panel not loaded: ' + id;
    ph.appendChild(msg);
    host.appendChild(ph);
  }

  function switchTab(shell, id) {
    // Defensive rescan: TG_PANELS may have grown since last switch.
    const mounted = mountPanel(id);
    const host = document.getElementById('panel-host');
    // Hide all panel-views.
    const views = host ? host.querySelectorAll('.panel-view') : [];
    for (const v of views) v.classList.remove('view-show');
    // Hide original panes (statusbar + SSE dot untouched).
    shell.main.classList.add('view-hide');
    if (mounted) {
      const target = document.getElementById('pv-' + id);
      if (target) target.classList.add('view-show');
      syncTabs(shell.nav, id);
    } else {
      // Unknown panel id → placeholder.
      showPlaceholder(host, id);
      const target = document.getElementById('pv-' + id);
      if (target) target.classList.add('view-show');
      syncTabs(shell.nav, id);
    }
  }

  function syncTabs(nav, activeId) {
    const btns = nav.querySelectorAll('.tab');
    for (const b of btns) {
      b.classList.toggle('active', b.dataset.tab === activeId);
    }
  }

  function init() {
    const shell = ensureShell();
    if (!shell) {
      // Retry once the DOM is ready.
      ready(init);
      return;
    }
    buildTabs(shell);
    // Default to Console.
    switchTab(shell, 'console');
    // Expose internals for testing.
    window.TG_CORE = { TABS: TAB_IDS, switchTab, mountPanel, scanPanels };
  }

  ready(init);
})();
