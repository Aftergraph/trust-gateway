/* G5 (§18.7) — keyboard map registry. Loaded BEFORE app.js.
 *
 * Single source of truth for every keybinding in the operator console,
 * across three contexts: global | queue | palette (§18.7 table).
 *
 * Exposes window.TG_KEYS = { bindings, detectConflicts, helpVisible }.
 * '?' opens the help overlay, which renders ALL bindings from this
 * registry — the registry is the only place a binding is declared.
 *
 * Runtime keys owned natively elsewhere stay documented here with
 * native: true (the palette input handler in app.js owns Esc/Enter/↑↓
 * inside the palette). Queue shortcuts operate on the focused approval
 * card in #pending (a=approve, d=deny, j/k=focus next/prev).
 *
 * detectConflicts(bindings) rejects double (context, key) bindings: it
 * runs at init (console.error + later binding disabled) and is reused by
 * app/compose.js to validate manifest keybindings arrays (§19.3).
 *
 * XSS: textContent only — never innerHTML.
 */
(function () {
  'use strict';

  var CONTEXTS = ['global', 'queue', 'palette'];

  // ── registry (§18.7) ────────────────────────────────────────────────────
  // key notation: 'mod+k' = ⌘K / Ctrl+K; 'g h' = two-stroke sequence;
  // anything else is a literal key name (e.g. 'a', '?', 'Escape').
  var bindings = [
    // global
    { context: 'global', key: 'mod+k', description: 'Open palette (command input focused)', run: openPalette },
    { context: 'global', key: 'g h', description: 'Go to History domain', run: function () { switchDomain('history'); } },
    { context: 'global', key: 'g n', description: 'Go to NOW domain', run: function () { switchDomain('now'); } },
    { context: 'global', key: '?', description: 'Toggle keyboard help overlay', run: toggleHelp },
    { context: 'global', key: 'Escape', description: 'Close open modal / drawer', run: closeHelp },
    // queue (an approval card in #pending is focused)
    { context: 'queue', key: 'a', description: 'Approve the focused card', run: function () { cardAction('.btn.ok'); } },
    { context: 'queue', key: 'd', description: 'Deny the focused card', run: function () { cardAction('.btn.no'); } },
    { context: 'queue', key: 'j', description: 'Focus next approval card', run: function () { moveFocus(1); } },
    { context: 'queue', key: 'k', description: 'Focus previous approval card', run: function () { moveFocus(-1); } },
    { context: 'queue', key: 'Escape', description: 'Dismiss card focus highlight', run: blurCard },
    // palette (owned by the palette input handler in app.js — documented so
    // this registry remains the single source of truth for §18.7)
    { context: 'palette', key: 'Escape', description: 'Close palette', native: true },
    { context: 'palette', key: 'Enter', description: 'Submit / select suggestion', native: true },
    { context: 'palette', key: 'ArrowDown', description: 'Next suggestion', native: true },
    { context: 'palette', key: 'ArrowUp', description: 'Previous suggestion', native: true },
  ];

  // ── conflict detection: no double (context, key) binding, ever ──────────
  function normalizeKey(key) {
    return String(key).trim().toLowerCase();
  }
  function detectConflicts(list) {
    var seen = {};
    var dupes = [];
    (list || []).forEach(function (b, i) {
      if (!b || typeof b.key !== 'string' || typeof b.context !== 'string') return;
      var id = b.context + '::' + normalizeKey(b.key);
      if (seen[id] !== undefined) dupes.push({ context: b.context, key: b.key, index: i, first: seen[id] });
      else seen[id] = i;
    });
    return dupes;
  }

  // init-time check: console.error + disable the later duplicate (§18.7 MUST).
  detectConflicts(bindings).forEach(function (c) {
    console.error('[TG_KEYS] duplicate (context,key) binding: ' + c.context + ' "' + c.key + '" — later binding disabled');
    bindings[c.index].disabled = true;
  });

  // ── helpers ─────────────────────────────────────────────────────────────
  function find(context, key) {
    var want = normalizeKey(key);
    for (var i = 0; i < bindings.length; i++) {
      var b = bindings[i];
      if (b.context === context && !b.disabled && b.run && normalizeKey(b.key) === want) return b;
    }
    return null;
  }
  function run(b) { if (b && typeof b.run === 'function') b.run(); }

  function openPalette() {
    var T = window.TG;
    if (T && typeof T.openPalette === 'function') T.openPalette();
  }
  function switchDomain(id) {
    var core = window.TG_CORE;
    if (core && typeof core.switchDomain === 'function') core.switchDomain(id);
  }

  function inTextField(t) {
    if (!t || !t.tagName) return false;
    var tag = t.tagName.toLowerCase();
    return tag === 'input' || tag === 'textarea' || tag === 'select' || !!t.isContentEditable;
  }
  function paletteOpen() { return !!document.querySelector('.palette-modal.view-show'); }
  function queueCard() {
    var a = document.activeElement;
    if (!a || !a.closest) return null;
    return a.closest('#pending .card');
  }
  function focusedCardIndex(cards) {
    var a = document.activeElement;
    if (!a || !a.closest) return -1;
    var card = a.closest('#pending .card');
    return cards.indexOf(card);
  }

  function cardAction(btnSelector) {
    var card = queueCard();
    if (!card) return;
    var btn = card.querySelector(btnSelector);
    if (btn) btn.click();
  }

  function moveFocus(dir) {
    var cards = Array.prototype.slice.call(document.querySelectorAll('#pending .card'));
    if (!cards.length) return;
    var idx = focusedCardIndex(cards);
    var next = idx === -1 ? (dir > 0 ? 0 : cards.length - 1) : Math.min(cards.length - 1, Math.max(0, idx + dir));
    var card = cards[next];
    card.tabIndex = 0;
    cards.forEach(function (c) { c.classList.toggle('kbd-focus', c === card); });
    card.focus();
  }
  function blurCard() {
    var cards = Array.prototype.slice.call(document.querySelectorAll('#pending .card'));
    cards.forEach(function (c) { c.classList.remove('kbd-focus'); });
    if (document.activeElement && document.activeElement.blur) document.activeElement.blur();
  }

  // ── help overlay ('?') — renders the registry, Esc closes ───────────────
  var helpEl = null;
  function prettyKey(key) {
    var k = String(key);
    if (k === 'mod+k') return '⌘K / Ctrl+K';
    if (k === 'Escape') return 'Esc';
    if (k === 'g h') return 'g then h';
    if (k === 'g n') return 'g then n';
    if (k === 'ArrowDown') return '↓';
    if (k === 'ArrowUp') return '↑';
    return k;
  }
  function ensureHelp() {
    if (helpEl) return helpEl;
    var wrap = document.createElement('div');
    wrap.className = 'modal help-modal';
    wrap.id = 'keys-help';
    var box = document.createElement('div');
    box.className = 'help-box';
    var title = document.createElement('h3');
    title.textContent = 'Keyboard shortcuts';
    box.appendChild(title);
    CONTEXTS.forEach(function (ctx) {
      var h = document.createElement('h4');
      h.textContent = ctx;
      box.appendChild(h);
      var table = document.createElement('table');
      bindings.filter(function (b) { return b.context === ctx && !b.disabled; }).forEach(function (b) {
        var tr = document.createElement('tr');
        var td1 = document.createElement('td');
        td1.textContent = prettyKey(b.key);
        var td2 = document.createElement('td');
        td2.textContent = b.description;
        tr.appendChild(td1);
        tr.appendChild(td2);
        table.appendChild(tr);
      });
      box.appendChild(table);
    });
    var hint = document.createElement('p');
    hint.className = 'muted';
    hint.textContent = 'Esc closes this overlay.';
    box.appendChild(hint);
    wrap.appendChild(box);
    document.body.appendChild(wrap);
    helpEl = wrap;
    return helpEl;
  }
  function helpVisibleNow() { return !!(helpEl && helpEl.classList.contains('view-show')); }
  function openHelp() { ensureHelp().classList.add('view-show'); }
  function closeHelp() { if (helpEl) helpEl.classList.remove('view-show'); }
  function toggleHelp() { if (helpVisibleNow()) closeHelp(); else openHelp(); }

  // ── the §18.7 single keydown dispatcher ─────────────────────────────────
  var pendingG = 0; // timestamp of a trailing 'g' (two-stroke sequences)

  function eventKey(e) {
    if ((e.metaKey || e.ctrlKey) && (e.key === 'k' || e.key === 'K')) return 'mod+k';
    if (e.metaKey || e.ctrlKey || e.altKey) return null; // other modifier combos pass through
    if (e.key === 'Escape') return 'Escape';
    if (e.key.length === 1) return e.key.toLowerCase();
    return null; // Enter / Arrow* / Tab etc. are context-native
  }

  document.addEventListener('keydown', function (e) {
    // help overlay owns Esc while open (Modal/Drawer close, §18.7)
    if (helpVisibleNow() && e.key === 'Escape') { closeHelp(); e.preventDefault(); return; }

    var k = eventKey(e);
    if (!k) return;

    // palette context: keys are handled natively by the palette input handler.
    if (paletteOpen()) return;

    if (inTextField(e.target)) return;

    // queue context: an approval card is focused
    if (queueCard()) {
      var qb = find('queue', k);
      if (qb) { e.preventDefault(); run(qb); }
      return;
    }

    // global context
    if (k === 'g') { pendingG = Date.now(); return; }
    if (pendingG && Date.now() - pendingG < 1500 && (k === 'h' || k === 'n')) {
      pendingG = 0;
      var seq = find('global', 'g ' + k);
      if (seq) { e.preventDefault(); run(seq); }
      return;
    }
    pendingG = 0;
    var gb = find('global', k);
    if (gb) { e.preventDefault(); run(gb); }
  }, true);

  // ── export ──────────────────────────────────────────────────────────────
  window.TG_KEYS = {
    bindings: bindings,
    contexts: CONTEXTS,
    detectConflicts: detectConflicts,
    get helpVisible() { return helpVisibleNow(); },
  };
})();