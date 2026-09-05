'use strict';
// Rooms panel (wave B UI) — W2 group rooms console section.
// Registers into window.TG_PANELS; the core tab-router mounts render(hostEl)
// when the "Rooms" tab is selected.
//
// Endpoints (src/gateway/mounts/25-groups.js):
//   GET    /v2/rooms               list
//   POST   /v2/rooms               create {name, bots}
//   GET    /v2/rooms/:id           detail incl. messages
//   DELETE /v2/rooms/:id           drop (creator or operator)
//   POST   /v2/rooms/:id/messages  A2A envelope {from, kind, body}
//
// UI contract:
//   • room list + create form (name, comma-separated bot names)
//   • selected room shows the message thread, each row tagged with a
//     bot/human badge (members.bots vs members.humans) and colored by
//     kind: message | handoff | proposal
//   • live-append: onAudit room_message payloads for the OPEN room are
//     appended live (deduped by messageId, fast path when the frame
//     carries body, otherwise reconciled via GET /v2/rooms/:id)
//   • post-message input posts as forge (from: 'forge')
//   • mention shortcut: one @bot quick-insert button per bot member
//   • thread render is capped at the last 100 messages
//
// XSS policy: textContent only — no innerHTML anywhere (test-enforced).

(function () {
  if (!window.TG || !window.TG.api || !window.TG.el) return; // core shell not ready

  const api = window.TG.api;
  const el = window.TG.el;
  const POST_AS = 'forge';   // the console posts room messages as this bot
  const RENDER_CAP = 100;    // max messages rendered per thread

  let mdRender = null;
  try { mdRender = window.TG_MD ? window.TG_MD.render : require('../../app/lib/md.js').render; } catch { mdRender = null; }

  const KIND_CLASS = {
    message: 'kind-message',
    handoff: 'kind-handoff',
    proposal: 'kind-proposal',
    assistant: 'kind-assistant',
  };

  function membersOf(room) {
    const m = room && room.members;
    return {
      bots: m && Array.isArray(m.bots) ? m.bots : [],
      humans: m && Array.isArray(m.humans) ? m.humans : [],
    };
  }

  function kindOf(m) {
    return KIND_CLASS[m.kind] ? m.kind : 'message';
  }

  function bodyText(m) {
    if (typeof m.body === 'string') return m.body;
    return m.body === null || m.body === undefined ? '' : JSON.stringify(m.body);
  }

  // One thread row: from + bot/human badge + kind chip + body + time.
  function messageRow(m, members) {
    const kind = kindOf(m);
    const row = el('div', 'roommsg ' + KIND_CLASS[kind]);
    row.append(el('span', 'roommsg-from', m.from || '?'));
    if (members.bots.includes(m.from)) row.append(el('span', 'badge bot', 'bot'));
    else if (members.humans.includes(m.from)) row.append(el('span', 'badge human', 'human'));
    row.append(el('span', 'roommsg-kind ' + KIND_CLASS[kind], kind));
    const bodyEl = el('span', 'roommsg-body');
    const text = bodyText(m);
    if (kind === 'assistant' && mdRender) {
      try {
        const rendered = mdRender(text);
        for (const c of (rendered.children || [])) bodyEl.append(c);
      } catch { bodyEl.textContent = text; }
    } else {
      bodyEl.textContent = text;
    }
    row.append(bodyEl);
    if (kind === 'assistant' && m.proposal && m.proposal.tool) {
      // governed proposal card: vises kun som METADATA (tool + decision) — aldrig args
      const card = el('div', 'roommsg-proposal');
      card.append(el('span', 'proposal-label', 'proposal'));
      card.append(el('span', 'proposal-tool', String(m.proposal.tool)));
      if (m.proposal.decision) card.append(el('span', 'proposal-decision', String(m.proposal.decision)));
      if (m.fallback) card.append(el('span', 'proposal-fallback', 'fallback'));
      row.append(card);
    }
    row.append(el('span', 'roommsg-ts', m.ts ? new Date(m.ts).toLocaleTimeString() : ''));
    return row;
  }

  function render(hostEl) {
    hostEl.textContent = '';
    const wrap = el('div', 'rooms-panel');

    // ── create form: name + comma-separated bot names ──────────────────
    const form = el('form', 'room-create');
    const nameIn = el('input', 'room-in');
    nameIn.placeholder = 'room name';
    const botsIn = el('input', 'room-in');
    botsIn.placeholder = 'bots (comma separated)';
    const mk = el('button', 'btn ok', 'create room');
    const formMsg = el('span', 'muted', '');
    form.append(nameIn, botsIn, mk, formMsg);
    form.addEventListener('submit', (ev) => {
      ev.preventDefault();
      const name = nameIn.value.trim();
      if (!name) { formMsg.textContent = 'name required'; return; }
      const bots = botsIn.value.split(',').map((s) => s.trim()).filter(Boolean);
      formMsg.textContent = '…';
      api('/v2/rooms', { method: 'POST', body: JSON.stringify({ name, bots, autoAddCreator: false }) })
        .then(() => { formMsg.textContent = 'created'; nameIn.value = ''; botsIn.value = ''; refreshList(); })
        .catch((err) => { formMsg.textContent = 'error ' + (err.status || err.message || ''); });
    });

    // ── room list ──────────────────────────────────────────────────────
    const list = el('div', 'room-list');

    function roomCard(room) {
      const members = membersOf(room);
      const card = el('div', 'room-card');
      const head = el('div', 'room-head');
      head.append(el('b', null, room.name || room.id));
      head.append(el('span', 'muted', String(room.messageCount == null ? (room.messages || []).length : room.messageCount) + ' msgs'));
      head.append(el('span', 'muted', 'turn cap ' + (room.turnLimit == null ? '∞' : room.turnLimit)));
      const open = el('button', 'btn ok', 'open');
      open.addEventListener('click', () => openRoom(room.id));
      const drop = el('button', 'btn no', 'drop');
      drop.addEventListener('click', () => {
        api('/v2/rooms/' + encodeURIComponent(room.id), { method: 'DELETE' })
          .then(() => { if (selectedId === room.id) closeRoom(); refreshList(); })
          .catch((err) => window.alert('drop failed: ' + (err.status || err.message)));
      });
      head.append(open, drop);
      card.append(head);
      const memberLine = members.bots.concat(members.humans).join(', ');
      if (memberLine) card.append(el('div', 'room-members muted', memberLine));
      return card;
    }

    function refreshList() {
      api('/v2/rooms')
        .then((d) => {
          list.textContent = '';
          const rooms = (d && d.rooms) || [];
          if (!rooms.length) { list.append(el('div', 'empty', 'no rooms — create one above')); return; }
          for (const room of rooms) list.append(roomCard(room));
        })
        .catch(() => {
          list.textContent = '';
          list.append(el('div', 'empty', window.TG.authed() ? 'rooms unavailable' : 'enter a token to load rooms'));
        });
    }

    // ── selected room: thread + post input + mention shortcuts ─────────
    const detail = el('div', 'room-detail');
    detail.style.display = 'none';
    let selectedId = null;
    let currentMembers = { bots: [], humans: [] };
    const seenMessages = new Set(); // appended messageIds (live-append dedupe)
    let loading = false;

    function closeRoom() {
      selectedId = null;
      seenMessages.clear();
      detail.style.display = 'none';
      detail.textContent = '';
    }

    function findLog() {
      for (const n of detail.children) if (n.className === 'room-log') return n;
      for (const n of detail.children) if (n.children) {
        for (const c of n.children) if (c.className === 'room-log') return c;
      }
      return null;
    }

    // Delegation tree renderer
  function delegationNode(node, depth = 0) {
    const li = el('li', 'delegation-node');
    const wrap = el('div', 'delegation-header');
    const hasChildren = node.children && node.children.length;
    const toggle = el('button', 'toggle-btn', hasChildren ? '▼' : '▶');
    toggle.style.marginLeft = `${depth * 16}px`;
    const info = el('span', 'delegation-info');
    info.append(el('strong', null, node.kind || 'node'));
    info.append(el('span', 'muted', ` (${node.from || '?'})`));
    wrap.append(toggle, info);
    li.append(wrap);
    if (hasChildren) {
      const ul = el('ul', 'delegation-children');
      for (const child of node.children) ul.append(delegationNode(child, depth + 1));
      li.append(ul);
      ul.style.display = 'none';
    }
    toggle.addEventListener('click', () => {
      const ul = li.querySelector('ul');
      if (ul) {
        ul.style.display = ul.style.display === 'none' ? '' : 'none';
        toggle.textContent = ul.style.display === 'none' ? '▶' : '▼';
      }
    });
    return li;
  }

  function renderDelegationTree(tree, containerEl) {
    containerEl.textContent = '';
    if (!tree) { containerEl.append(el('div', 'empty', 'no delegation chain')); return; }
    const ul = el('ul', 'delegation-root');
    ul.append(delegationNode(tree));
    containerEl.append(ul);
  }

  function openRoom(roomId) {
      if (loading) return;
      loading = true;
      api('/v2/rooms/' + encodeURIComponent(roomId))
        .then((d) => {
          loading = false;
          if (selectedId !== roomId && selectedId !== null) return; // user moved on
          const room = (d && d.room) || {};
          selectedId = roomId;
          currentMembers = membersOf(room);
          seenMessages.clear();
          detail.textContent = '';
          detail.style.display = '';

          const head = el('div', 'room-head');
          head.append(el('h3', null, room.name || roomId));
          const close = el('button', 'btn', 'close');
          close.addEventListener('click', closeRoom);
          head.append(close);
          detail.append(head);
          const memberLine = currentMembers.bots.map((b) => '@' + b).concat(currentMembers.humans).join(', ');
          detail.append(el('div', 'room-members muted', 'members: ' + (memberLine || '(none)')));

          // Tab navigation
          const tabs = el('div', 'room-tabs');
          const msgTab = el('button', 'tab-btn active', 'Messages');
          const chainTab = el('button', 'tab-btn', 'Delegation');
          tabs.append(msgTab, chainTab);
          detail.append(tabs);

          const log = el('div', 'room-log');
          const msgs = room.messages || [];
          if (!msgs.length) log.append(el('div', 'empty', 'no messages yet'));
          // render cap: only the LAST RENDER_CAP messages
          for (const m of msgs.slice(-RENDER_CAP)) log.append(messageRow(m, currentMembers));
          detail.append(log);
          // Delegation chain container
          const chainView = el('div', 'room-log', 'delegation-chain');
          chainView.style.display = 'none';
          detail.append(chainView);

          // post form — posts as forge
          const send = el('form', 'room-send');
          const bodyIn = el('input', 'room-body-in');
          bodyIn.placeholder = 'message as ' + POST_AS;
          const sendBtn = el('button', 'btn ok', 'send');
          const sendMsg = el('span', 'muted', '');
          // mention shortcut: one quick-insert per bot member
          const mentions = el('div', 'room-mentions');
          for (const b of currentMembers.bots) {
            const mb = el('button', 'mention-btn', '@' + b);
            mb.addEventListener('click', (ev) => {
              ev.preventDefault();
              bodyIn.value = bodyIn.value ? bodyIn.value.replace(/\s*$/, ' ') + '@' + b + ' ' : '@' + b + ' ';
              bodyIn.focus && bodyIn.focus();
            });
            mentions.append(mb);
          }
          const askBtn = el('button', 'btn', 'ask'); // A1: spørg hjernen — governed LLM turn
          askBtn.title = 'spørg hjernen (governed: proposal + approval-kort i tråden)';
          send.append(mentions, bodyIn, sendBtn, askBtn, sendMsg);
          askBtn.addEventListener('click', (ev2) => {
            ev2.preventDefault();
            const body = bodyIn.value.trim();
            if (!body) return;
            askBtn.disabled = true;
            sendMsg.textContent = '…hjernen tænker';
            // A2: stream deltas live; done-event bærer det governed verdict.
            const token = window.TG.token || (window.TG.auth && window.TG.auth.token) || '';
            fetch('/v2/chat/llm/stream', {
              method: 'POST',
              headers: { 'content-type': 'application/json', authorization: 'Bearer ' + token },
              body: JSON.stringify({ session: 'room_' + roomId, message: body }),
            }).then((resp) => {
              if (!resp.ok || !resp.body) { askBtn.disabled = false; sendMsg.textContent = 'error ' + resp.status; return; }
              const reader = resp.body.getReader();
              const dec = new TextDecoder();
              let buf = '';
              let replyText = '';
              const pump = () => reader.read().then(({ done, value }) => {
                if (done) {
                  askBtn.disabled = false;
                  bodyIn.value = '';
                  openRoom(roomId);
                  return;
                }
                buf += dec.decode(value, { stream: true });
                let idx;
                while ((idx = buf.indexOf('\n\n')) >= 0) {
                  const block = buf.slice(0, idx); buf = buf.slice(idx + 2);
                  let ev = '', data = '';
                  for (const line of block.split('\n')) {
                    if (line.startsWith('event:')) ev = line.slice(6).trim();
                    if (line.startsWith('data:')) data = line.slice(5).trim();
                  }
                  if (!data) continue;
                  try {
                    const d = JSON.parse(data);
                    if (ev === 'delta' && d.text) { replyText += d.text; sendMsg.textContent = replyText.slice(-60); }
                    if (ev === 'done' && d.fallback) sendMsg.textContent = 'fallback';
                  } catch { /* ignore malformed block */ }
                }
                pump();
              });
              pump();
            }).catch(() => { askBtn.disabled = false; sendMsg.textContent = 'error'; });
          });
          send.addEventListener('submit', (ev2) => {
            ev2.preventDefault();
            const body = bodyIn.value.trim();
            if (!body) return;
            sendMsg.textContent = '…';
            api('/v2/rooms/' + encodeURIComponent(roomId) + '/messages', {
              method: 'POST',
              body: JSON.stringify({ from: POST_AS, kind: 'message', body }),
            })
              .then(() => { sendMsg.textContent = ''; bodyIn.value = ''; openRoom(roomId); })
              .catch((err) => {
                sendMsg.textContent = err.status === 409 ? 'cap reached'
                  : err.status === 403 ? 'denied' : 'error ' + (err.status || '');
              });
          });
          detail.append(send);

          // Tab switching and delegation chain fetch
          let chainTree = null;
          const switchTab = (activeBtn, activeView) => {
            for (const t of tabs.children) t.classList.remove('active');
            activeBtn.classList.add('active');
            for (const v of [log, chainView]) v.style.display = v === activeView ? '' : 'none';
          };
          msgTab.addEventListener('click', () => switchTab(msgTab, log));
          chainTab.addEventListener('click', () => {
            switchTab(chainTab, chainView);
            if (!chainTree) {
              api('/v2/rooms/' + encodeURIComponent(roomId) + '/chain')
                .then((d) => {
                  chainTree = (d && d.tree) || null;
                  renderDelegationTree(chainTree, chainView);
                })
                .catch(() => {
                  chainTree = null;
                  renderDelegationTree(null, chainView);
                });
            }
          });

          log.scrollTop = log.scrollHeight;
        })
        .catch((err) => {
          loading = false;
          if (selectedId !== roomId && selectedId !== null) return;
          detail.textContent = '';
          detail.style.display = '';
          detail.append(el('div', 'empty', err && err.status === 404 ? 'room gone' : 'load failed'));
        });
    }

    // ── live-append from the shared SSE audit fan-out ───────────────────
    // room_message audit payload: {type, roomId, messageId, from, to, kind,
    // bodyLength} — the task contract also allows a body field on the wire;
    // when present we append directly, otherwise we reconcile via the API.
    window.TG.onAudit((e) => {
      const p = e && e.payload;
      if (!p || typeof p.type !== 'string') return;
      if (p.type === 'room_created' || p.type === 'room_deleted') { refreshList(); return; }
      if (p.type !== 'room_message' || p.roomId !== selectedId) return;
      const logEl = findLog();
      if (!logEl) return;
      if (p.messageId && seenMessages.has(p.messageId)) return; // dedupe fanout hops
      if (p.messageId) seenMessages.add(p.messageId);
      if (typeof p.body === 'string') {
        // fast path: the frame carried the body — append directly
        logEl.append(messageRow({ from: p.from, kind: p.kind, body: p.body, ts: e.ts }, currentMembers));
      } else {
        // audit frames carry bodyLength only — reconcile from the API
        if (!loading) openRoom(selectedId);
        return;
      }
      while (logEl.children.length > RENDER_CAP) logEl.removeChild(logEl.firstChild);
      logEl.scrollTop = logEl.scrollHeight;
    });

    wrap.append(form, list, detail);
    hostEl.append(wrap);
    refreshList();
  }

  (window.TG_PANELS = window.TG_PANELS || []).push({ id: 'rooms', title: 'Rooms', render });
})();