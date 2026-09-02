'use strict';
// Panel: Artifacts (wave B) — follow-along viewer for W5 /v2/artifacts.
//
// Contract (see docs/v2/PLATFORM-ABI.md):
//   register (window.TG_PANELS = window.TG_PANELS || []).push({id,title,render});
//   render(container, TG?) — TG defaults to window.TG ({api,el,token,authed,refresh,onAudit}).
//   XSS policy: every server/bot-derived string goes into textContent ONLY.
//   No innerHTML anywhere in this file.
//
// Layout: list (kind tag · title · bot · version) → detail pane (<pre> content,
// version history selector) → create form (kind select, title, content).
// Live: onAudit `artifact_updated` for the selected artifact refetches the
// detail + list and flashes the content pane.
(function () {
  const KINDS = ['code', 'doc', 'image-ref', 'report'];

  function fmtTime(ts) {
    try { return new Date(ts).toISOString().replace('T', ' ').slice(0, 19); }
    catch { return String(ts == null ? '' : ts); }
  }

  function panel(TG) {
    const el = TG.el;
    const state = { list: [], selectedId: null, detail: null };

    const root = el('div', 'tg-artifacts');

    // ── header: refresh + status ──
    const status = el('span', 'muted', '');
    const refreshBtn = el('button', 'btn', 'refresh');
    const head = el('div', 'art-head');
    head.append(refreshBtn, status);

    // ── list ──
    const list = el('div', 'art-list');

    // ── detail pane ──
    const dTitle = el('h3', 'art-title', '');
    const dMeta = el('div', 'muted', '');
    const vSelect = el('select', 'art-versions');
    const pre = el('pre', 'art-content');
    const detailBox = el('div', 'art-detail');
    detailBox.append(dTitle, dMeta, vSelect, pre);

    // ── create form ──
    const kindSel = el('select', 'art-new-kind');
    KINDS.forEach((k) => {
      const o = el('option', null, k);
      o.value = k;
      kindSel.appendChild(o);
    });
    const titleInput = el('input', 'art-new-title');
    titleInput.placeholder = 'title';
    const contentTa = el('textarea', 'art-new-content');
    contentTa.placeholder = 'content';
    const createBtn = el('button', 'btn ok', 'create');
    const formMsg = el('div', 'muted', '');
    const formBox = el('div', 'art-new');
    formBox.append(kindSel, titleInput, contentTa, createBtn, formMsg);

    root.append(head, list, detailBox, formBox);

    function setMsg(node, text) { node.textContent = text == null ? '' : String(text); }

    // ── list ──
    async function loadList() {
      if (!TG.authed()) {
        list.textContent = '';
        list.appendChild(el('div', 'empty', 'connect a token'));
        return;
      }
      try {
        const d = await TG.api('/v2/artifacts');
        state.list = (d && d.artifacts) || [];
        renderList();
        setMsg(status, state.list.length + ' artifacts');
      } catch (e) {
        setMsg(status, e && e.status === 401 ? 'unauthorized' : 'load failed');
      }
    }

    function renderList() {
      list.textContent = '';
      if (!state.list.length) {
        list.appendChild(el('div', 'empty', 'no artifacts yet'));
        return;
      }
      state.list.forEach((a) => {
        const row = el('div', 'art-row' + (a.id === state.selectedId ? ' selected' : ''));
        row.append(
          el('span', 'tag kind-' + a.kind, a.kind),
          el('b', 'art-row-title', a.title == null ? '(untitled)' : String(a.title)),
          el('span', 'who', a.bot || ''),
          el('span', 'muted', 'v' + a.version)
        );
        row.addEventListener('click', () => { select(a.id); });
        list.appendChild(row);
      });
    }

    // ── detail ──
    async function select(id) {
      state.selectedId = id;
      renderList();
      try {
        const d = await TG.api('/v2/artifacts/' + encodeURIComponent(id));
        state.detail = (d && d.artifact) || null;
        renderDetail();
      } catch (e) {
        setMsg(status, e && e.status === 404 ? 'artifact gone' : 'load failed');
      }
    }

    function renderDetail() {
      const a = state.detail;
      if (!a) {
        dTitle.textContent = '';
        dMeta.textContent = '';
        vSelect.textContent = '';
        pre.textContent = '';
        return;
      }
      dTitle.textContent = a.title == null ? '(untitled)' : String(a.title);
      dMeta.textContent = a.kind + ' · ' + (a.bot || '—') + ' · updated ' + fmtTime(a.updatedAt);
      vSelect.textContent = '';
      const versions = a.versions || [];
      versions.forEach((v, i) => {
        const o = el('option', null, 'v' + v.v + ' · ' + (v.bot || '') + ' · ' + fmtTime(v.ts));
        o.value = String(i);
        vSelect.appendChild(o);
      });
      vSelect.value = String(Math.max(0, versions.length - 1)); // latest by default
      showVersion();
    }

    function showVersion() {
      const a = state.detail;
      const i = parseInt(vSelect.value, 10);
      const v = a && a.versions && a.versions[Number.isNaN(i) ? -1 : i];
      pre.textContent = v && v.content != null ? String(v.content) : '';
    }
    vSelect.addEventListener('change', showVersion);

    // ── create ──
    createBtn.addEventListener('click', async () => {
      const kind = kindSel.value;
      const title = String(titleInput.value || '').trim();
      const content = String(contentTa.value || '');
      if (!title) return setMsg(formMsg, 'title required');
      if (!KINDS.includes(kind)) return setMsg(formMsg, 'bad kind');
      createBtn.disabled = true;
      setMsg(formMsg, 'creating…');
      try {
        const r = await TG.api('/v2/artifacts', {
          method: 'POST',
          body: JSON.stringify({ kind, title, content }),
        });
        titleInput.value = '';
        contentTa.value = '';
        setMsg(formMsg, 'created');
        await loadList();
        if (r && r.artifact && r.artifact.id) await select(r.artifact.id);
      } catch (e) {
        setMsg(formMsg, e && e.status === 401 ? 'unauthorized' : 'create failed');
      } finally {
        createBtn.disabled = false;
      }
    });

    refreshBtn.addEventListener('click', () => { loadList(); });

    // ── live follow-along ──
    let flashTimer = null;
    function highlight() {
      pre.style.outline = '2px solid #2ea043';
      if (pre.classList && pre.classList.add) pre.classList.add('art-live');
      const t = setTimeout(() => {
        pre.style.outline = '';
        if (pre.classList && pre.classList.remove) pre.classList.remove('art-live');
      }, 1500);
      if (t && typeof t.unref === 'function') t.unref(); // node-test hygiene; no-op in browsers
    }

    if (typeof TG.onAudit === 'function') {
      TG.onAudit((e) => {
        const p = e && e.payload;
        if (!p) return;
        if (p.type === 'artifact_created') { loadList(); return; }
        if (p.type === 'artifact_updated' && state.selectedId && p.artifactId === state.selectedId) {
          loadList();
          highlight();
          select(state.selectedId); // refetch detail → latest version lands in <pre>
        }
      });
    }

    loadList();
    return root;
  }

  function render(container, TG) {
    const tg = TG || (typeof window !== 'undefined' ? window.TG : null);
    if (!tg || typeof tg.api !== 'function') return null;
    const node = panel(tg);
    if (container && typeof container.appendChild === 'function') container.appendChild(node);
    return node;
  }

  (window.TG_PANELS = window.TG_PANELS || []).push({ id: 'artifacts', title: 'Artifacts', render });
})();