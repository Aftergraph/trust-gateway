'use strict';
// Goals & Loops panel (wave B UI) — W10 continuity console section.
// Registers into window.TG_PANELS; the core tab-router (app/panels/core.js)
// mounts render(hostEl) when the "Goals" tab is clicked.
//
// Endpoints (src/gateway/mounts/50-continuity.js + 16-bots.js):
//   GET  /v2/goals[?all=1]           list goals (projected: no step args)
//   POST /v2/goals                   {text, owner, steps:[{tool,args?}]}
//   POST /v2/goals/:id/step          advance one governed step
//   POST /v2/goals/:id/resume        resume (if paused) + replay next step
//   POST /v2/slash                   {cmd} — /goal /loop /resume console
//   GET  /v2/bots                    owner select source {bots:[{name,...}]}
//
// Pause and clear are slash-only actions (engine API), so their buttons go
// through POST /v2/slash {cmd:'/goal pause <id>'} / {cmd:'/goal clear <id>'}.
//
// Live: window.TG.onAudit — any goal_* / goal_loop_* / slash_run event
// refetches the touched goal card (goalId from the audit payload); slash_run
// without a goalId refreshes the whole list (e.g. /goal add).
//
// XSS policy: textContent only — no innerHTML anywhere (test-enforced).

(function () {
  if (!window.TG || !window.TG.api || !window.TG.el) return; // core shell not ready

  const api = window.TG.api;
  const el = window.TG.el;

  const STATUS_CLASS = {
    active: 'pill status-active',
    paused: 'pill status-paused',
    done: 'pill status-done',
    cleared: 'pill status-cleared',
  };

  // lastDecision → css color class (policy outcomes)
  const DECISION_CLASS = {
    allow: 'ld-allow',
    approved: 'ld-approved',
    needs_approval: 'ld-needs',
    deny: 'ld-deny',
    none: 'ld-none',
  };

  function decisionClass(d) {
    return DECISION_CLASS[d] || 'ld-none';
  }

  function stepsTable(steps) {
    const table = el('table', 'goal-steps');
    const thead = el('thead');
    const hr = el('tr');
    for (const h of ['tool', 'state', 'attempts', 'lastDecision']) hr.append(el('th', null, h));
    thead.append(hr);
    table.append(thead);
    const tbody = el('tbody');
    if (!steps.length) {
      const tr = el('tr');
      tr.append(el('td', 'empty', 'no steps'));
      tbody.append(tr);
    }
    for (const s of steps || []) {
      const tr = el('tr');
      tr.append(el('td', 'step-tool', s.tool || '?'));
      tr.append(el('td', 'step-state st-' + (s.state || 'pending'), s.state || 'pending'));
      tr.append(el('td', 'step-attempts', String(s.attempts == null ? 0 : s.attempts)));
      tr.append(el('td', 'step-dec ' + decisionClass(s.lastDecision), s.lastDecision || '—'));
      tbody.append(tr);
    }
    table.append(tbody);
    return table;
  }

  function goalCard(goal, onChange) {
    const card = el('div', 'goal-card');
    card.dataset.goalId = goal.id;

    const head = el('div', 'goal-head');
    const pill = el('span', STATUS_CLASS[goal.status] || 'pill', goal.status || 'active');
    const owner = el('span', 'goal-owner muted', 'owner: ' + (goal.owner || '?'));
    const id = el('span', 'goal-id muted', goal.id || '');
    head.append(pill, el('b', 'goal-text', goal.text || ''), owner, id);
    card.append(head);

    card.append(stepsTable(goal.steps || []));

    const btns = el('div', 'goal-actions');
    const msg = el('span', 'muted', '');

    const stepBtn = el('button', 'btn ok', 'step now');
    stepBtn.addEventListener('click', () => {
      msg.textContent = '…';
      api('/v2/goals/' + encodeURIComponent(goal.id) + '/step', { method: 'POST', body: '{}' })
        .then((out) => {
          msg.textContent = out.done ? 'done' : 'step ' + (out.stepIndex == null ? '—' : out.stepIndex) + ' → ' + (out.decision || 'none');
          if (out.goal) onChange(out.goal);
        })
        .catch((err) => {
          msg.textContent = err.status === 409 ? 'conflict (paused?)' : 'error ' + (err.status || '');
        });
    });
    btns.append(stepBtn);

    if (goal.status === 'paused') {
      const resumeBtn = el('button', 'btn ok', 'resume');
      resumeBtn.addEventListener('click', () => {
        msg.textContent = '…';
        api('/v2/goals/' + encodeURIComponent(goal.id) + '/resume', { method: 'POST', body: '{}' })
          .then((out) => {
            msg.textContent = 'resumed → ' + (out.decision || 'none');
            if (out.goal) onChange(out.goal);
          })
          .catch((err) => { msg.textContent = 'error ' + (err.status || ''); });
      });
      btns.append(resumeBtn);
    } else {
      const pauseBtn = el('button', 'btn', 'pause');
      pauseBtn.addEventListener('click', () => {
        msg.textContent = '…';
        api('/v2/slash', { method: 'POST', body: JSON.stringify({ cmd: '/goal pause ' + goal.id }) })
          .then((out) => { msg.textContent = out.message || 'paused'; })
          .catch((err) => { msg.textContent = 'error ' + (err.status || ''); });
      });
      btns.append(pauseBtn);
    }

    const clearBtn = el('button', 'btn no', 'delete');
    clearBtn.addEventListener('click', () => {
      msg.textContent = '…';
      api('/v2/slash', { method: 'POST', body: JSON.stringify({ cmd: '/goal clear ' + goal.id }) })
        .then((out) => { msg.textContent = out.message || 'cleared'; removeCard(goal.id); })
        .catch((err) => { msg.textContent = 'error ' + (err.status || ''); });
    });
    btns.append(clearBtn, msg);

    card.append(btns);
    return card;
  }

  function render(hostEl) {
    hostEl.textContent = '';
    const wrap = el('div', 'goals-panel');

    // --- add form ---
    const form = el('form', 'goal-create');
    const textIn = el('input', 'goal-in');
    textIn.placeholder = 'goal text';
    const ownerSel = el('select', 'goal-in narrow');
    const defOpt = el('option', null, 'owner: me');
    defOpt.value = '';
    ownerSel.append(defOpt);
    const toolIn = el('input', 'goal-in');
    toolIn.placeholder = 'first step tool (optional, e.g. fs.read)';
    const mk = el('button', 'btn ok', 'add goal');
    const formMsg = el('span', 'muted', '');
    form.append(textIn, ownerSel, toolIn, mk, formMsg);

    // populate owner select from the bot directory
    api('/v2/bots')
      .then((d) => {
        for (const b of (d && d.bots) || []) {
          const opt = el('option', null, b.name + (b.role ? ' (' + b.role + ')' : ''));
          opt.value = b.name;
          ownerSel.append(opt);
        }
      })
      .catch(() => { /* directory unavailable — keep "owner: me" */ });

    form.addEventListener('submit', (ev) => {
      ev.preventDefault();
      const text = textIn.value.trim();
      if (!text) { formMsg.textContent = 'text required'; return; }
      const body = { text };
      if (ownerSel.value) body.owner = ownerSel.value;
      const tool = toolIn.value.trim();
      if (tool) body.steps = [{ tool }];
      formMsg.textContent = '…';
      api('/v2/goals', { method: 'POST', body: JSON.stringify(body) })
        .then(() => {
          formMsg.textContent = 'added';
          textIn.value = '';
          toolIn.value = '';
          refreshList();
        })
        .catch((err) => { formMsg.textContent = 'error ' + (err.status || ''); });
    });

    // --- slash console ---
    const slash = el('form', 'goal-slash');
    const slashIn = el('input', 'goal-in');
    slashIn.placeholder = '/goal | /loop start <id> [everyMs] [maxRuns] | /loop stop <id> | /resume [id]';
    const slashBtn = el('button', 'btn ok', 'run');
    const slashOut = el('div', 'slash-out empty', '');
    slashOut.style.display = 'none';
    slash.append(slashIn, slashBtn, slashOut);
    slash.addEventListener('submit', (ev) => {
      ev.preventDefault();
      const cmd = slashIn.value.trim();
      if (!cmd) return;
      slashBtn.disabled = true;
      slashOut.textContent = '…';
      slashOut.style.display = '';
      api('/v2/slash', { method: 'POST', body: JSON.stringify({ cmd }) })
        .then((out) => {
          slashOut.textContent = JSON.stringify(out);
          slashIn.value = '';
          refreshList();
        })
        .catch((err) => { slashOut.textContent = 'error ' + (err.status || '') + ': ' + (err.message || ''); })
        .finally(() => { slashBtn.disabled = false; });
    });

    // --- list ---
    const list = el('div', 'goal-list');
    const listTitle = el('h3', null, 'goals');

    // swap a single card in place (onChange callback from buttons / audit refetch)
    function replaceCard(goal) {
      if (!goal || !goal.id) return;
      const old = list.querySelector('[data-goal-id="' + CSS.escape(goal.id) + '"]');
      const fresh = goalCard(goal, replaceCard);
      if (old) list.replaceChild(fresh, old); else list.append(fresh);
    }
    function removeCard(goalId) {
      const old = list.querySelector('[data-goal-id="' + CSS.escape(goalId) + '"]');
      if (old) old.remove();
    }

    function refreshList() {
      return api('/v2/goals')
        .then((d) => {
          list.textContent = '';
          const goals = (d && d.goals) || [];
          if (!goals.length) { list.append(el('div', 'empty', 'no goals — add one above')); return; }
          for (const g of goals) list.append(goalCard(g, replaceCard));
        })
        .catch(() => {
          list.textContent = '';
          list.append(el('div', 'empty', window.TG.authed() ? 'goals unavailable' : 'enter a token to load goals'));
        });
    }

    // live updates: goal_* audit events refetch the touched goal only
    window.TG.onAudit((e) => {
      const p = e && e.payload;
      const t = p && p.type;
      if (typeof t !== 'string') return;
      if (t === 'slash_run') return; // slash output already shown; slash handlers refetch
      if (t.indexOf('goal') !== 0) return;
      const goalId = p.goalId;
      if (!goalId) { refreshList(); return; }
      api('/v2/goals')
        .then((d) => {
          const g = ((d && d.goals) || []).find((x) => x.id === goalId);
          if (!g) { removeCard(goalId); return; } // cleared / filtered out
          replaceCard(g);
        })
        .catch(() => { /* transient — next event retries */ });
    });

    wrap.append(form, slash, listTitle, list);
    hostEl.append(wrap);
    refreshList();
  }

  (window.TG_PANELS = window.TG_PANELS || []).push({ id: 'goals', title: 'Goals & Loops', render });
})();