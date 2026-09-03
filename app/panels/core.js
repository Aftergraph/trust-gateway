'use strict';
// Trust Gateway v2 — Core tab router.
// Builds the #tabs nav, lazy-mounts registered TG_PANELS into <main>'s parent,
// hides the original 3-pane <main class="panes"> via the view-hide class.
// XSS policy: textContent only, no innerHTML. Idempotent + defensive against
// TG_PANELS being empty or growing later (rescan on each tab switch).
//
// Phase 2 (§20.3): the nav shows the 9 DOMAIN rail. Each domain owns a set of
// panels (the old 13 tabs become sub-panels inside their domain). Old tab ids
// redirect to their domain (§20.3 redirect map, G11) — bookmarked #history
// still works, no broken-URL window. Kill-switch: ?tabs=legacy restores the
// 13-tab Phase-1 behavior verbatim.
(function () {
  // ── Legacy 13-tab order (Phase 1) — kept for the kill-switch ──────────
  const TABS_LEGACY = [
    { id: 'console', title: 'Console' },
    { id: 'history', title: 'History' },
    { id: 'rooms', title: 'Rooms' },
    { id: 'artifacts', title: 'Artifacts' },
    { id: 'goals', title: 'Goals' },
    { id: 'builder', title: 'Builder' },
    { id: 'hub', title: 'Hub' },
    { id: 'providers', title: 'Providers' },
    { id: 'providers-live', title: 'Live' },
    { id: 'computer', title: 'Computer' },
    { id: 'playground', title: 'Playground' },
    { id: 'voice', title: 'Voice' },
    { id: 'integrations', title: 'Integrations' },
  ];

  // ── Phase 2: the 9-domain rail (§2.1). Each domain lists its panels in
  // display order; the first panel is the domain's landing surface. Panel
  // ids are the SAME as the Phase-1 tab ids — panels register in TG_PANELS
  // by id and are mounted on demand inside their active domain.
  const DOMAINS = [
    { id: 'now',   title: 'NOW',     panels: ['console'] },
    { id: 'chat',  title: 'CHAT',    panels: ['rooms'] },
    { id: 'work',  title: 'WORK',    panels: ['goals', 'builder'] },
    { id: 'agents', title: 'AGENTS', panels: ['agents'] },
    { id: 'brain', title: 'BRAIN',   panels: ['providers', 'providers-live'] },
    { id: 'output', title: 'OUTPUT', panels: ['artifacts', 'history', 'playground'] },
    { id: 'control', title: 'CONTROL', panels: ['computer'] },
    { id: 'connect', title: 'CONNECT', panels: ['hub', 'integrations', 'voice'] },
    { id: 'system', title: 'SYSTEM',  panels: ['system'] },
  ];

  // ── §20.3 redirect map: old tab id → domain. G11 (no broken URLs). ─────
  const LEGACY_TAB_TO_DOMAIN = {
    console: 'now',
    rooms: 'now',
    history: 'output',
    artifacts: 'output',
    playground: 'output',
    goals: 'work',
    builder: 'work',
    hub: 'connect',
    voice: 'connect',
    integrations: 'connect',
    providers: 'brain',
    'providers-live': 'brain',
    computer: 'control',
  };

  function useLegacyTabs() {
    try { return /[?&]tabs=legacy\b/.test(location.search); } catch { return false; }
  }

  // panel id → its owning domain id (built once for reverse lookups).
  const PANEL_TO_DOMAIN = {};
  for (const d of DOMAINS) for (const p of d.panels) PANEL_TO_DOMAIN[p] = d.id;

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
    while (nav.firstChild) nav.removeChild(nav.firstChild);
    if (useLegacyTabs()) {
      for (const t of TABS_LEGACY) {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'tab';
        btn.dataset.tab = t.id;
        btn.textContent = t.title;
        btn.addEventListener('click', () => switchTab(shell, t.id));
        nav.appendChild(btn);
      }
      return;
    }
    // Domain rail: one button per domain, plus a subnav host beneath.
    for (const d of DOMAINS) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'tab domain';
      btn.dataset.domain = d.id;
      btn.textContent = d.title;
      btn.addEventListener('click', () => switchDomain(shell, d.id));
      nav.appendChild(btn);
    }
    // Subnav strip for the active domain's panels (only when >1 panel).
    let sub = document.getElementById('subtabs');
    if (!sub) {
      sub = document.createElement('nav');
      sub.id = 'subtabs';
      sub.className = 'subtabs';
      nav.parentNode.insertBefore(sub, nav.nextSibling);
    }
  }

  function buildSubtabs(shell, domain) {
    const sub = document.getElementById('subtabs');
    if (!sub) return;
    sub.textContent = '';
    const d = DOMAINS.find((x) => x.id === domain);
    if (!d || d.panels.length < 2) { sub.style.display = 'none'; return; }
    sub.style.display = 'flex';
    for (const pid of d.panels) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'subtab';
      btn.dataset.panel = pid;
      btn.textContent = panelTitle(pid);
      btn.addEventListener('click', () => showPanel(shell, domain, pid));
      sub.appendChild(btn);
    }
    syncSubtabs(sub, currentPanel(domain));
  }

  function panelTitle(id) {
    const t = TABS_LEGACY.find((x) => x.id === id);
    return t ? t.title : id;
  }

  // Remember the last-opened panel per domain so re-entering a domain
  // restores context (§2.3: back/forward is a graph walk, revisit re-renders).
  const domainLastPanel = {};
  function currentPanel(domain) {
    const d = DOMAINS.find((x) => x.id === domain);
    return domainLastPanel[domain] || (d && d.panels[0]) || 'console';
  }

  function mountPanel(id) {
    const panels = scanPanels();
    const found = panels.find((p) => p.id === id);
    if (!found) return false;
    const section = document.getElementById('pv-' + id);
    if (section) return true;
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

  function clearViews(host) {
    const views = host ? host.querySelectorAll('.panel-view') : [];
    for (const v of views) v.classList.remove('view-show');
    const stale = document.getElementById('pv-console');
    if (stale && stale.parentNode) stale.parentNode.removeChild(stale);
  }

  function syncDomainTabs(nav, activeDomain) {
    const btns = nav.querySelectorAll('.tab.domain');
    for (const b of btns) b.classList.toggle('active', b.dataset.domain === activeDomain);
  }

  function syncSubtabs(sub, activePanel) {
    const btns = sub ? sub.querySelectorAll('.subtab') : [];
    for (const b of btns) b.classList.toggle('active', b.dataset.panel === activePanel);
  }

  function setUrlFor(domain) {
    try {
      const want = '/' + domain;
      if (location.pathname !== want && !(domain === 'now' && (location.pathname === '/' || location.pathname === ''))) {
        history.pushState({ domain }, '', want + location.search + location.hash);
      }
    } catch { /* file:// or sandboxed */ }
  }

  function switchDomain(shell, domain) {
    const d = DOMAINS.find((x) => x.id === domain) || DOMAINS[0];
    setUrlFor(d.id);
    syncDomainTabs(shell.nav, d.id);
    buildSubtabs(shell, d.id);
    showPanel(shell, d.id, currentPanel(d.id));
  }

  function showPanel(shell, domain, panelId) {
    domainLastPanel[domain] = panelId;
    const host = document.getElementById('panel-host');
    if (panelId === 'console') {
      // 'console' is the original 3-pane grid, not a TG_PANELS panel.
      clearViews(host);
      shell.main.classList.remove('view-hide');
      syncSubtabs(document.getElementById('subtabs'), 'console');
      return;
    }
    shell.main.classList.add('view-hide');
    clearViews(host);
    const mounted = mountPanel(panelId);
    const target = document.getElementById('pv-' + panelId);
    if (target) target.classList.add('view-show');
    if (!mounted) showPlaceholder(host, panelId);
    const re = document.getElementById('pv-' + panelId);
    if (re) re.classList.add('view-show');
    syncSubtabs(document.getElementById('subtabs'), panelId);
  }

  // Legacy-compatible entry: switchTab(anyPanelId) resolves the id to its
  // domain and shows the panel inside it. Phase-1 callers (palette, queue
  // strip, TG_HISTORY.jumpToSeq) keep working unchanged.
  function switchTab(shell, id) {
    if (useLegacyTabs()) {
      // Phase-1 behavior: flat tabs, console is the 3-pane.
      const nav = shell.nav;
      const btns = nav.querySelectorAll('.tab:not(.domain)');
      for (const b of btns) b.classList.toggle('active', b.dataset.tab === id);
      const host = document.getElementById('panel-host');
      if (id === 'console') { clearViews(host); shell.main.classList.remove('view-hide'); return; }
      shell.main.classList.add('view-hide');
      clearViews(host);
      const mounted = mountPanel(id);
      const t = document.getElementById('pv-' + id);
      if (t) t.classList.add('view-show');
      if (!mounted) showPlaceholder(host, id);
      return;
    }
    const domain = PANEL_TO_DOMAIN[id] || LEGACY_TAB_TO_DOMAIN[id] || (DOMAINS.find((d) => d.id === id) ? id : 'now');
    switchDomain(shell, domain);
    // If id is a specific panel in that domain, show it (else landing panel).
    const d = DOMAINS.find((x) => x.id === domain);
    if (d && d.panels.indexOf(id) !== -1) showPanel(shell, domain, id);
  }

  // Map a location (path /now, hash #history, or deep object /d/... handled
  // server-side) to an initial domain. §20.3: no 404 windows — every old
  // anchor lands on its domain.
  function initialDomain() {
    try {
      const p = location.pathname.replace(/^\/+/, '').replace(/\/+$/, '');
      if (DOMAINS.some((d) => d.id === p)) return p;
      const h = (location.hash || '').replace(/^#/, '');
      if (h && LEGACY_TAB_TO_DOMAIN[h]) return LEGACY_TAB_TO_DOMAIN[h];
      if (h && DOMAINS.some((d) => d.id === h)) return h;
    } catch { /* noop */ }
    return 'now';
  }

  function init() {
    const shell = ensureShell();
    if (!shell) { ready(init); return; }
    buildTabs(shell);
    const start = initialDomain();
    switchDomain(shell, start);
    // Back/forward is a graph walk (§2.3): re-resolve on popstate.
    window.addEventListener('popstate', () => { switchDomain(shell, initialDomain()); });
    // Deep object link (/d/DOMAIN/o/type/id): resolve via the API and open
    // the owning panel; history's jumpToSeq handles auditentry hits (§2.2).
    try {
      const dm = location.pathname.match(/^\/d\/([A-Z]+)\/o\/([A-Za-z]+)\/([^/?#]+)$/);
      if (dm && window.TG && typeof window.TG.api === 'function') {
        const uri = '/d/' + dm[1] + '/o/' + dm[2] + '/' + encodeURIComponent(dm[3]);
        window.TG.api(uri).then((r) => {
          if (!r || !r.resolved) return;
          const panel = r.panel || 'console';
          if (panel === 'history' && r.object && typeof r.object.seq === 'number' && window.TG_HISTORY && window.TG_HISTORY.jumpToSeq) {
            window.TG_HISTORY.jumpToSeq(r.object.seq);
          } else {
            switchTab(shell, panel);
          }
        }).catch(() => { /* unauthenticated shell — the connect flow takes over */ });
      }
    } catch { /* noop */ }
    window.TG_CORE = {
      DOMAINS: DOMAINS.map((d) => d.id),
      TABS: DOMAINS.map((d) => d.id),
      switchTab: (id) => switchTab(shell, id),
      switchDomain: (id) => switchDomain(shell, id),
      mountPanel, scanPanels,
      redirectMap: LEGACY_TAB_TO_DOMAIN,
    };
  }

  ready(init);
})();
