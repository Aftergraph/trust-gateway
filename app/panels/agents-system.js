'use strict';
// Trust Gateway v2 — AGENTS + SYSTEM panels (phase 2 domain rail).
//
// AGENTS: workforce as objects — registered bots + declared capabilities,
// live run counts per agent (GET /v2/runs is per-bot scoped by RBAC).
// SYSTEM: console's own state — health, chain seal, storage, mounts.
// XSS policy: textContent only, no innerHTML.
(function () {
  window.TG_PANELS = window.TG_PANELS || [];
  if (window.TG_PANELS.some((p) => p && p.id === 'agents')) return;

  function el(tag, cls, text) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined) n.textContent = text;
    return n;
  }

  // ── AGENTS ────────────────────────────────────────────────────────────
  function renderAgents(host) {
    host.textContent = '';
    host.append(el('h3', null, 'Agents'));
    const list = el('div', 'agents-list');
    host.appendChild(list);
    Promise.all([
      window.TG.api('/v2/bots').catch(() => ({ bots: [] })),
      window.TG.api('/v2/runs?limit=50').catch(() => ({ runs: [] })),
    ]).then(([b, r]) => {
      list.textContent = '';
      const runs = r.runs || [];
      (b.bots || []).forEach((bot) => {
        const row = el('div', 'botrow');
        row.append(el('b', null, bot.name));
        row.append(el('span', 'role ' + (bot.role || 'worker'), bot.role || 'worker'));
        const mine = runs.filter((x) => x.bot === bot.name);
        const active = mine.filter((x) => x.state === 'running' || x.state === 'paused').length;
        row.append(el('span', 'muted', (active ? active + ' active · ' : '') + mine.length + ' runs'));
        row.append(el('span', 'caps muted', (bot.capabilities || []).slice(0, 6).join(' ')));
        list.appendChild(row);
      });
      if (!(b.bots || []).length) list.appendChild(el('div', 'empty', 'no agents visible'));
    });
  }

  // ── SYSTEM ────────────────────────────────────────────────────────────
  function renderSystem(host) {
    host.textContent = '';
    host.append(el('h3', null, 'System'));
    const grid = el('div', 'sys-grid');
    host.appendChild(grid);
    Promise.all([
      fetch('/healthz').then((r) => r.json()).catch(() => null),
      window.TG.api('/v1/audit/verify').catch(() => null),
      window.TG.api('/v2/stats').catch(() => null),
    ]).then(([h, v, s]) => {
      grid.textContent = '';
      const cards = [
        ['Health', h ? (h.ok ? 'ok' : 'degraded') : 'unreachable'],
        ['Audit chain', (h && h.chain) ? ((h.chain.ok ? 'SEALED ✓' : 'TAMPERED ✖') + ' (' + (h.chain.length || '?') + ')') : (v ? (v.ok ? 'SEALED ✓ (' + v.length + ')' : 'TAMPERED ✖') : 'n/a')],
        ['Entries', v ? v.length : (h && h.chain ? h.chain.length : 'n/a')],
        ['Bots', s && s.bots ? Object.keys(s.bots).length : 'n/a'],
      ];
      for (const [k, val] of cards) {
        const c = el('div', 'card');
        c.append(el('div', 'card-title', k));
        c.append(el('div', 'card-reason', String(val)));
        grid.appendChild(c);
      }
    });
  }

  window.TG_PANELS.push({ id: 'agents', title: 'Agents', render: renderAgents });
  window.TG_PANELS.push({ id: 'system', title: 'System', render: renderSystem });
})();
