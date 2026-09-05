'use strict';
// D3 — Command palette (cmd+K / ctrl+K). 0 deps, XSS-loven: textContent-only.
//
// API: init(), open(), close(), toggle(), isOpen(), register({id,label,run}),
//      filtered(query) — returnerer matchende kommandoer (case-insensitive).
// init() bygger overlay-DOM'en én gang og binder global keydown:
//   cmd/ctrl+K → toggle; Escape → luk; Enter → kør markerede; ArrowUp/Down → flyt.
// Register kan kaldes når som helst (paneler registrerer deres kommandoer).

const commands = []; // {id, label, run}
let overlay = null;
let inputEl = null;
let listEl = null;
let selected = 0;
let open_ = false;
let bound = false;

function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
}

function ensureDom() {
  if (overlay) return;
  overlay = el('div', 'cmdk-overlay');
  if (overlay.style) overlay.style.display = 'none';
  const box = el('div', 'cmdk-box');
  inputEl = el('input', 'cmdk-input');
  inputEl.placeholder = 'Søg kommando… (Enter kører, Esc lukker)';
  inputEl.addEventListener('input', () => render());
  inputEl.addEventListener('keydown', (e) => {
    const matches = filtered(inputEl.value);
    if (e.key === 'Escape') { e.preventDefault && e.preventDefault(); close(); }
    else if (e.key === 'Enter') {
      e.preventDefault && e.preventDefault();
      const cmd = matches[selected] || matches[0];
      if (cmd) { close(); cmd.run(); }
    } else if (e.key === 'ArrowDown') {
      e.preventDefault && e.preventDefault();
      selected = Math.min(selected + 1, matches.length - 1);
      render();
    } else if (e.key === 'ArrowUp') {
      e.preventDefault && e.preventDefault();
      selected = Math.max(0, selected - 1);
      render();
    }
  });
  listEl = el('div', 'cmdk-list');
  box.append(inputEl, listEl);
  overlay.append(box);
  // klik udenfor lukker
  overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
  document.body ? document.body.append(overlay) : document.documentElement.append(overlay);
}

function filtered(query) {
  const q = String(query || '').toLowerCase().trim();
  if (!q) return commands;
  return commands.filter((c) => c.label.toLowerCase().includes(q) || c.id.toLowerCase().includes(q));
}

function render() {
  if (!listEl) return;
  listEl.textContent = '';
  const matches = filtered(inputEl ? inputEl.value : '');
  if (selected >= matches.length) selected = Math.max(0, matches.length - 1);
  matches.forEach((cmd, i) => {
    const row = el('div', 'cmdk-row' + (i === selected ? ' selected' : ''), cmd.label);
    listEl.append(row);
  });
  if (!matches.length) listEl.append(el('div', 'cmdk-empty', 'ingen kommandoer'));
}

function open() {
  ensureDom();
  open_ = true;
  if (overlay.style) overlay.style.display = '';
  selected = 0;
  if (inputEl) { inputEl.value = ''; }
  render();
}

function close() {
  open_ = false;
  if (overlay && overlay.style) overlay.style.display = 'none';
}

function isOpen() { return open_; }

function register(cmd) {
  if (!cmd || !cmd.id || !cmd.label || typeof cmd.run !== 'function') return;
  if (commands.some((c) => c.id === cmd.id)) return;
  commands.push(cmd);
}

function init() {
  ensureDom();
  document.addEventListener('keydown', (e) => {
    if ((e.metaKey || e.ctrlKey) && String(e.key).toLowerCase() === 'k') {
      e.preventDefault && e.preventDefault();
      open_ ? close() : open();
    }
  });
}

if (typeof window !== 'undefined') {
  window.TG_CMDK = { init, open, close, isOpen, register, filtered, toggle: () => (open_ ? close() : open()) };
}

module.exports = { init, open, close, isOpen, register, filtered,
  get input() { return inputEl; },
  get _overlay() { return overlay; },
};