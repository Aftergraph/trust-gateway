'use strict';
// Workforce builder panel (wave B UI) — W3 no-code custom-agent builder.
// Registers into window.TG_PANELS; the core tab-router (app/panels/core.js)
// mounts render(hostEl) when the "Workforce builder" tab is clicked.
//
// ROLE_CAPABILITIES (hardcoded from src/gateway/policy.js — do not edit policy):
//   worker:   ['fs.read', 'fs.write:*', 'web.get', 'web.search']
//   analyst:  ['fs.read', 'web.get', 'web.search', 'db.read:*']
//   operator: ['fs.read', 'fs.write:*', 'shell.run', 'web.get'] // still gated: shell = destructive
//   auditor:  ['fs.read', 'audit.read']
// The create form's capabilities checkbox list is derived from these sets:
// editing a role swaps the checkbox list to that role's caps (defaults checked).
//
// Endpoints (src/gateway/mounts/31-agents.js):
//   GET    /v2/agents            list custom agents
//   POST   /v2/agents            create {name, role, capabilities?, persona?}
//   PUT    /v2/agents/:name      update {role?, capabilities?, persona?}
//   DELETE /v2/agents/:name      remove (operator only) — confirm() first
//   GET    /v2/profiles/:who     read profile {persona, settings}
//   PUT    /v2/profiles/:who     write {persona?, settings?}
//
// Fail-closed messaging: 403 → "operator token required" inline; 400/409 →
// the server's error code inline. No window.alert for policy rejections —
// the UI never hides a privileged-attempt rejection.
//
// XSS policy: textContent only — no innerHTML anywhere (test-enforced).

(function () {
  if (!window.TG || !window.TG.api || !window.TG.el) return; // core shell not ready

  const api = window.TG.api;
  const el = window.TG.el;

  // From src/gateway/policy.js ROLE_CAPABILITIES (keep in sync).
  const ROLE_CAPABILITIES = {
    worker: ['fs.read', 'fs.write:*', 'web.get', 'web.search'],
    analyst: ['fs.read', 'web.get', 'web.search', 'db.read:*'],
    operator: ['fs.read', 'fs.write:*', 'shell.run', 'web.get'], // still gated: shell = destructive
    auditor: ['fs.read', 'audit.read'],
  };
  const FORM_ROLES = ['worker', 'analyst', 'operator']; // create form offers these; auditor listed for completeness
  const PRIVILEGED_NOTE = 'operator role / privileged caps (shell.run) need an operator token';

  // Map server error codes to short, fail-closed inline messages.
  function errText(status, code) {
    if (status === 403) return 'operator token required (403)';
    if (status === 401) return 'unauthorized — connect a token first (401)';
    if (status === 400) return 'rejected: ' + (code || 'invalid input') + ' (400)';
    if (status === 409) return 'rejected: ' + (code || 'conflict') + ' (409)';
    if (status === 404) return 'not found (404)';
    return 'error ' + (status || '') + (code ? ' ' + code : '');
  }
  function respError(err) {
    return errText(err.status, err.code || err.bodyError || '');
  }

  // fetch wrapper that preserves the HTTP error body's {error} code.
  function apiErr(path, opts) {
    return api(path, opts).catch((err) => {
      // window.TG.api throws Error with .status; extract code when the
      // rejection carries the parsed body (fail-closed default otherwise).
      err.code = err.code || (err.payload && err.payload.error) || '';
      throw err;
    });
  }

  function capChip(cap) {
    return el('span', 'cap-chip', cap);
  }
  function roleBadge(role) {
    return el('span', 'role-badge role-' + (ROLE_CAPABILITIES[role] ? role : 'other'), role || '?');
  }

  function agentRow(agent, onEdit, onDelete) {
    const card = el('div', 'agent-card');
    const head = el('div', 'agent-head');
    head.append(el('b', null, agent.name));
    head.append(roleBadge(agent.role));
    const del = el('button', 'btn no', 'delete');
    del.addEventListener('click', () => onDelete(agent));
    const edit = el('button', 'btn', 'edit profile');
    edit.addEventListener('click', () => onEdit(agent));
    head.append(edit, del);
    card.append(head);

    const caps = el('div', 'cap-row');
    const list = Array.isArray(agent.capabilities) ? agent.capabilities : [];
    if (!list.length) caps.append(el('span', 'muted', 'no capabilities'));
    for (const c of list) caps.append(capChip(c));
    card.append(caps);

    if (agent.persona) {
      card.append(el('div', 'agent-persona muted', String(agent.persona).slice(0, 200)));
    }
    return card;
  }

  // Capabilities checkbox list derived from ROLE_CAPABILITIES[role].
  function buildCapChecks(roleSel, capBox) {
    capBox.textContent = '';
    const role = roleSel.value;
    const caps = ROLE_CAPABILITIES[role] || [];
    for (const cap of caps) {
      const label = el('label', 'cap-check');
      const box = el('input');
      box.type = 'checkbox';
      box.value = cap;
      box.checked = true; // role defaults pre-checked
      label.append(box, el('span', null, cap));
      capBox.append(label);
    }
    const hint = el('div', 'muted', 'unchecking all sends no capabilities (server rejects invented caps)');
    capBox.append(hint);
  }
  function checkedCaps(capBox) {
    return [...capBox.querySelectorAll('input[type=checkbox]')]
      .filter((b) => b.checked)
      .map((b) => b.value);
  }

  function render(hostEl) {
    hostEl.textContent = '';
    const wrap = el('div', 'builder-panel');

    // ── agent list ─────────────────────────────────────────────────
    const listTitle = el('h3', null, 'custom agents');
    const list = el('div', 'agent-list');
    list.append(listTitle);

    // ── edit profile section (hidden until "edit" clicked) ─────────
    const editSec = el('div', 'builder-edit');
    editSec.style.display = 'none';
    let editWho = null;

    const editTitle = el('h3', null, 'edit profile');
    const personaTa = el('textarea', 'builder-persona');
    personaTa.placeholder = 'persona text (max 2000 chars)';
    personaTa.maxLength = 2000;
    const settingsTa = el('textarea', 'builder-settings');
    settingsTa.placeholder = 'settings JSON, e.g. {"tone":"terse"}';
    const editSave = el('button', 'btn ok', 'save profile');
    const editClose = el('button', 'btn', 'close');
    const editMsg = el('span', 'muted', '');
    const editRow = el('div', 'btnrow');
    editRow.append(editSave, editClose, editMsg);
    editSec.append(editTitle, personaTa, settingsTa, editRow);

    function closeEdit() {
      editSec.style.display = 'none';
      editSec.textContent = '';
      editSec.append(editTitle, personaTa, settingsTa, editRow);
      editWho = null;
    }

    function openEdit(name) {
      editWho = name;
      editMsg.textContent = '…';
      editSec.style.display = '';
      apiErr('/v2/profiles/' + encodeURIComponent(name))
        .then((d) => {
          if (editWho !== name) return;
          const p = (d && d.profile) || {};
          personaTa.value = p.persona == null ? '' : String(p.persona);
          settingsTa.value = p.settings && Object.keys(p.settings).length
            ? JSON.stringify(p.settings) : '';
          editMsg.textContent = '';
        })
        .catch((err) => {
          if (editWho !== name) return;
          personaTa.value = '';
          settingsTa.value = '';
          editMsg.textContent = respError(err); // 403 shows inline, fail closed
        });
    }

    editSave.addEventListener('click', () => {
      if (!editWho) return;
      const body = {};
      if (personaTa.value) body.persona = personaTa.value;
      if (settingsTa.value.trim()) {
        try { body.settings = JSON.parse(settingsTa.value); }
        catch { editMsg.textContent = 'rejected: settings must be valid JSON'; return; }
      }
      if (!('persona' in body) && !('settings' in body)) {
        editMsg.textContent = 'nothing to save'; return;
      }
      editMsg.textContent = '…';
      apiErr('/v2/profiles/' + encodeURIComponent(editWho), {
        method: 'PUT', body: JSON.stringify(body),
      })
        .then(() => { editMsg.textContent = 'profile saved'; })
        .catch((err) => { editMsg.textContent = respError(err); }); // 403/400 inline
    });
    editClose.addEventListener('click', closeEdit);

    // ── create form ────────────────────────────────────────────────
    const form = el('form', 'builder-create');
    const nameIn = el('input', 'builder-in');
    nameIn.placeholder = 'agent name (a-z0-9-, starts with a letter)';
    const roleSel = el('select', 'builder-in narrow');
    for (const r of FORM_ROLES) {
      const opt = el('option', null, r);
      opt.value = r;
      roleSel.append(opt);
    }
    const personaIn = el('textarea', 'builder-persona');
    personaIn.placeholder = 'persona (optional, max 2000 chars)';
    personaIn.maxLength = 2000;
    const capBox = el('div', 'cap-box');
    const mk = el('button', 'btn ok', 'create agent');
    const formMsg = el('span', 'muted', '');
    form.append(nameIn, roleSel, personaIn, capBox, mk, formMsg);
    roleSel.addEventListener('change', () => buildCapChecks(roleSel, capBox));
    buildCapChecks(roleSel, capBox);

    form.addEventListener('submit', (ev) => {
      ev.preventDefault();
      const name = nameIn.value.trim();
      const persona = personaIn.value;
      const body = { name, role: roleSel.value, capabilities: checkedCaps(capBox) };
      if (persona) body.persona = persona;
      formMsg.textContent = '…';
      apiErr('/v2/agents', { method: 'POST', body: JSON.stringify(body) })
        .then(() => {
          formMsg.textContent = 'created ' + name;
          nameIn.value = '';
          personaIn.value = '';
          buildCapChecks(roleSel, capBox);
          refreshList();
        })
        .catch((err) => {
          // fail-closed: 403/400 surface inline, never swallowed
          formMsg.textContent = respError(err);
        });
    });

    // ── list + delete ──────────────────────────────────────────────
    function refreshList() {
      apiErr('/v2/agents')
        .then((d) => {
          list.textContent = '';
          list.append(listTitle);
          const agents = (d && d.agents) || [];
          if (!agents.length) {
            list.append(el('div', 'empty', 'no custom agents — create one above'));
            return;
          }
          for (const a of agents) {
            list.append(agentRow(
              a,
              (agent) => openEdit(agent.name),
              (agent) => {
                if (!window.confirm('delete agent "' + agent.name + '"?')) return;
                apiErr('/v2/agents/' + encodeURIComponent(agent.name), { method: 'DELETE' })
                  .then(() => refreshList())
                  .catch((err) => window.alert(respError(err)));
              },
            ));
          }
        })
        .catch(() => {
          list.textContent = '';
          list.append(el('div', 'empty',
            window.TG.authed() ? 'agents unavailable' : 'enter a token to load agents'));
        });
    }

    // live updates: agent_created/deleted/updated arrive via SSE fan-out
    window.TG.onAudit((e) => {
      const t = e && e.payload && e.payload.type;
      if (t === 'agent_created' || t === 'agent_deleted' || t === 'agent_updated') refreshList();
    });

    wrap.append(form, list, editSec);
    hostEl.append(wrap);
    refreshList();
  }

  (window.TG_PANELS = window.TG_PANELS || []).push({ id: 'builder', title: 'Workforce builder', render });
})();