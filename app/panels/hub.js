'use strict';
// Hub panel (wave B UI) — W4 plugins + skills + MCP console section.
// Registers into window.TG_PANELS; the core tab-router (app/panels/core.js)
// mounts render(hostEl) when the "Hub" tab is clicked.
//
// Endpoints (src/gateway/mounts/35-plugins.js):
//   GET    /v2/plugins               list installed modules {modules:[...]}
//   POST   /v2/plugins               install-by-id {id}
//   POST   /v2/plugins/:id/enable    enable (audited: plugin_enabled)
//   POST   /v2/plugins/:id/disable   disable (audited: plugin_disabled)
//   DELETE /v2/plugins/:id           uninstall (audited: plugin_uninstalled)
//   GET    /v2/skills                {skills:[{name,description,trigger}]}
//   GET    /v2/mcp                   {servers:[...]} (env values never shown)
//   POST   /v2/mcp                   register {name, transport, command|url}
//
// Live updates: plugin_* audit events (shared SSE fan-out) → refresh sections.
// XSS policy: textContent only — no innerHTML anywhere (test-enforced).

(function () {
  if (!window.TG || !window.TG.api || !window.TG.el) return; // core shell not ready

  const api = window.TG.api;
  const el = window.TG.el;

  const errText = (err) => {
    if (!err) return 'error';
    if (err.status === 401) return 'unauthorized — connect a token';
    if (err.status === 403) return 'operator role required';
    if (err.status === 404) return 'not found';
    if (err.status === 409) return 'already registered';
    return 'error ' + (err.status || err.message || '');
  };

  // ── Plugins section ────────────────────────────────────────────────

  function pluginCard(mod, refresh) {
    const card = el('div', 'card');
    const head = el('div', 'card-title');
    head.append(el('span', null, mod.name || mod.id));
    head.append(el('span', 'muted', 'v' + (mod.version || '?') + (mod.enabled ? ' · enabled' : ' · disabled')));
    const actions = el('div', 'plugin-actions');
    const toggle = el('button', 'btn ' + (mod.enabled ? 'no' : 'ok'), mod.enabled ? 'disable' : 'enable');
    toggle.addEventListener('click', () => {
      actionsMsg.textContent = '…';
      api('/v2/plugins/' + encodeURIComponent(mod.id) + (mod.enabled ? '/disable' : '/enable'), { method: 'POST' })
        .then(refresh)
        .catch((err) => { actionsMsg.textContent = errText(err); refresh(); });
    });
    const uninstall = el('button', 'btn no', 'uninstall');
    uninstall.addEventListener('click', () => {
      actionsMsg.textContent = '…';
      api('/v2/plugins/' + encodeURIComponent(mod.id), { method: 'DELETE' })
        .then(refresh)
        .catch((err) => { actionsMsg.textContent = errText(err); refresh(); });
    });
    const actionsMsg = el('span', 'muted', '');
    actions.append(toggle, uninstall, actionsMsg);
    card.append(head, actions);
    const caps = (mod.capabilities || []);
    if (caps.length) card.append(el('div', 'muted', 'caps: ' + caps.join(', ')));
    const secrets = (mod.secrets || []);
    if (secrets.length) {
      card.append(el('div', 'muted', 'secrets: ' + secrets
        .map((s) => s.name + (s.configured ? ' ✓' : ' (unset)')).join(', ')));
    }
    return card;
  }

  function pluginsSection(refreshAll) {
    const sec = el('div', 'hub-section');
    sec.append(el('h3', null, 'plugins'));

    const err = el('div', 'hub-error', '');
    err.style.display = 'none';

    // install-by-id form
    const form = el('form', 'hub-form');
    const idIn = el('input', 'hub-in');
    idIn.placeholder = 'install module by id (e.g. weather)';
    const mk = el('button', 'btn ok', 'install');
    form.append(idIn, mk);
    form.addEventListener('submit', (ev) => {
      ev.preventDefault();
      const id = idIn.value.trim();
      if (!id) { err.textContent = 'module id required'; err.style.display = ''; return; }
      err.style.display = 'none';
      api('/v2/plugins', { method: 'POST', body: JSON.stringify({ id }) })
        .then(() => { idIn.value = ''; refreshAll(); })
        .catch((e) => {
          err.textContent = e.status === 400 ? 'install rejected: ' + (e.error || 'invalid id')
            : e.status === 404 ? 'module not found: ' + id
            : errText(e);
          err.style.display = '';
        });
    });

    const list = el('div', 'hub-list');

    function refresh() {
      api('/v2/plugins')
        .then((d) => {
          err.style.display = 'none';
          list.textContent = '';
          const mods = (d && (d.modules || d.plugins)) || [];
          if (!mods.length) { list.append(el('div', 'empty', 'no plugins installed')); return; }
          for (const mod of mods) list.append(pluginCard(mod, refresh));
        })
        .catch((e) => {
          list.textContent = '';
          list.append(el('div', 'empty', window.TG.authed() ? errText(e) : 'enter a token to load plugins'));
        });
    }

    sec.append(form, err, list);
    return { node: sec, refresh };
  }

  // ── Skills section ─────────────────────────────────────────────────

  function skillsSection() {
    const sec = el('div', 'hub-section');
    sec.append(el('h3', null, 'skills'));
    const err = el('div', 'hub-error', '');
    err.style.display = 'none';
    const list = el('div', 'hub-list');

    function refresh() {
      api('/v2/skills')
        .then((d) => {
          err.style.display = 'none';
          list.textContent = '';
          const skills = (d && d.skills) || [];
          if (!skills.length) { list.append(el('div', 'empty', 'no skills discovered')); return; }
          for (const s of skills) {
            const row = el('div', 'hub-row');
            row.append(el('b', null, s.name || s.file || '?'));
            row.append(el('span', 'muted', s.description || ''));
            row.append(el('span', 'hub-trigger', s.trigger ? 'trigger: ' + s.trigger : ''));
            list.append(row);
          }
          const rejected = (d && d.rejected) || [];
          if (rejected.length) {
            err.textContent = rejected.length + ' skill file(s) rejected (invalid frontmatter)';
            err.style.display = '';
          }
        })
        .catch((e) => {
          list.textContent = '';
          list.append(el('div', 'empty', window.TG.authed() ? errText(e) : 'enter a token to load skills'));
        });
    }

    sec.append(err, list);
    return { node: sec, refresh };
  }

  // ── MCP section ────────────────────────────────────────────────────

  function mcpSection(refreshAll) {
    const sec = el('div', 'hub-section');
    sec.append(el('h3', null, 'MCP servers'));
    const err = el('div', 'hub-error', '');
    err.style.display = 'none';

    // register form: name + transport + command (stdio) | url (http/sse)
    const form = el('form', 'hub-form');
    const nameIn = el('input', 'hub-in');
    nameIn.placeholder = 'name (lowercase slug)';
    const transportSel = el('select', 'hub-in narrow');
    for (const t of ['stdio', 'http', 'sse']) {
      const opt = el('option', null, t);
      opt.value = t;
      transportSel.append(opt);
    }
    const cmdIn = el('input', 'hub-in');
    cmdIn.placeholder = 'command (stdio)';
    const urlIn = el('input', 'hub-in');
    urlIn.placeholder = 'url (http/sse)';
    urlIn.style.display = 'none';
    transportSel.addEventListener('change', () => {
      const t = transportSel.value;
      cmdIn.style.display = t === 'stdio' ? '' : 'none';
      urlIn.style.display = t === 'stdio' ? 'none' : '';
    });
    const mk = el('button', 'btn ok', 'register');
    form.append(nameIn, transportSel, cmdIn, urlIn, mk);
    form.addEventListener('submit', (ev) => {
      ev.preventDefault();
      const name = nameIn.value.trim();
      if (!name) { err.textContent = 'name required'; err.style.display = ''; return; }
      const t = transportSel.value;
      const body = { name, transport: t };
      if (t === 'stdio') {
        const cmd = cmdIn.value.trim();
        if (!cmd) { err.textContent = 'command required for stdio'; err.style.display = ''; return; }
        body.command = cmd;
      } else {
        const u = urlIn.value.trim();
        if (!u) { err.textContent = 'url required for ' + t; err.style.display = ''; return; }
        body.url = u;
      }
      err.style.display = 'none';
      api('/v2/mcp', { method: 'POST', body: JSON.stringify(body) })
        .then(() => { nameIn.value = ''; cmdIn.value = ''; urlIn.value = ''; refreshAll(); })
        .catch((e) => {
          err.textContent = e.status === 409 ? 'already registered: ' + name
            : e.status === 400 ? 'rejected: ' + ((e.errors || [e.error]).join('; ') || 'invalid')
            : errText(e);
          err.style.display = '';
        });
    });

    const list = el('div', 'hub-list');

    function refresh() {
      api('/v2/mcp')
        .then((d) => {
          err.style.display = 'none';
          list.textContent = '';
          const servers = (d && d.servers) || [];
          if (!servers.length) { list.append(el('div', 'empty', 'no MCP servers registered')); return; }
          for (const s of servers) {
            const row = el('div', 'hub-row');
            row.append(el('b', null, s.name || '?'));
            row.append(el('span', 'muted', s.transport || ''));
            const where = s.transport === 'stdio' ? s.command : s.url;
            if (where) row.append(el('span', 'muted', where));
            if (s.envKeys && s.envKeys.length) row.append(el('span', 'muted', 'env: ' + s.envKeys.join(', ')));
            list.append(row);
          }
        })
        .catch((e) => {
          list.textContent = '';
          list.append(el('div', 'empty', window.TG.authed() ? errText(e) : 'enter a token to load MCP servers'));
        });
    }

    sec.append(form, err, list);
    return { node: sec, refresh };
  }

  // ── render ─────────────────────────────────────────────────────────

  function render(hostEl) {
    hostEl.textContent = '';
    const wrap = el('div', 'hub-panel');

    const plugins = pluginsSection(refreshAll);
    const skills = skillsSection();
    const mcp = mcpSection(refreshAll);

    function refreshAll() { plugins.refresh(); skills.refresh(); mcp.refresh(); }

    // plugin_* audit events (install/enable/disable/uninstall) → refresh all
    window.TG.onAudit((e) => {
      const t = e && e.payload && e.payload.type;
      if (typeof t === 'string' && t.indexOf('plugin_') === 0) refreshAll();
    });

    wrap.append(plugins.node, skills.node, mcp.node);
    hostEl.append(wrap);
    refreshAll();
  }

  (window.TG_PANELS = window.TG_PANELS || []).push({ id: 'hub', title: 'Hub', render });
})();