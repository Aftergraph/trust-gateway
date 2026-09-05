'use strict';
// D3 — Tema-toggle (dark/light). 0 deps.
//
// init(): læs localStorage 'tg-theme'; uden lagret værdi respekteres
// prefers-color-scheme. Sæt documentElement.dataset.theme.
// toggle(): dark <-> light, persisteres.

const KEY = 'tg-theme';

function current() {
  return document.documentElement.dataset.theme || null;
}

function apply(theme) {
  document.documentElement.dataset.theme = theme;
}

function init() {
  let t = null;
  try { t = localStorage.getItem(KEY); } catch { /* privat tilstand */ }
  if (t !== 'dark' && t !== 'light') {
    t = (typeof window !== 'undefined' && typeof window.matchMedia === 'function'
      && window.matchMedia('(prefers-color-scheme: light)').matches) ? 'light' : 'dark';
  }
  apply(t);
}

function toggle() {
  const next = current() === 'light' ? 'dark' : 'light';
  apply(next);
  try { localStorage.setItem(KEY, next); } catch { /* privat tilstand */ }
  return next;
}

module.exports = { init, toggle, current };

// Browser-binding (uden for node/test): window.TG_THEME
if (typeof window !== 'undefined') {
  window.TG_THEME = { init, toggle, current };
}