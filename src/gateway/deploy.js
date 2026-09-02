'use strict';
// C5 — deploy artifacts + status reporter + deploy-mode heuristic.
//
// This module PRODUCES TEXT ARTIFACTS ONLY. It never installs, enables, or
// starts a system service; that is an explicit non-goal (see deploy/cloud.md).
//
//  - renderService({port, envFile}) → systemd *user-level* unit text for
//    `node bin/gateway.js`. Placeholders are token-free by construction
//    (e.g. TG_BOT_TOKENS__SET_ME) so a rendered unit can never carry a real
//    secret, and so `git grep` on a leaked unit file is boring.
//  - renderPwaShortcut({url}) → Linux desktop launcher (.desktop text) plus a
//    copy-paste instructions block for Windows/macOS. The .desktop is the only
//    generated artifact; the Windows/macOS part is documentation that also
//    ships in deploy/cloud.md.
//  - statusReport(gw) → operator snapshot. envSet values are BOOLEANS ONLY —
//    the names of configured variables are surfaced, never their values.
//  - detectMode() → 'desktop' | 'cloud' | 'local-server'. A UI-facing
//    HEURISTIC, never a security decision: it is derived from TG_DEPLOY_MODE
//    or (systemd init + no ssh session) and may be wrong in either direction.

// Token-free placeholder scheme: every placeholder ends in __SET_ME so a
// naive grep for '__SET_ME' finds every spot an operator must edit, and no
// placeholder can be mistaken for a credential.
const PLACEHOLDERS = {
  botTokens: 'TG_BOT_TOKENS__SET_ME',
  llmKey: 'TG_LLM_KEY__SET_ME',
  ttsUrl: 'TG_TTS_URL__SET_ME',
  llmBaseUrl: 'TG_LLM_BASE_URL__SET_ME',
};

function renderService({ port = 8787, envFile = 'data/gateway.env' } = {}) {
  const p = Number(port) || 8787;
  // envFile stays as given (relative paths are legal for user units, resolved
  // against the home directory / WorkingDirectory); it is not a secret.
  return [
    '# systemd USER-LEVEL unit — install with:',
    '#   systemctl --user enable --now trust-gateway.service',
    '# (see deploy/cloud.md for the full runbook). Never installed by the app.',
    '',
    '[Unit]',
    'Description=Trust Gateway (user-level)',
    'After=network-online.target',
    'Wants=network-online.target',
    '',
    '[Service]',
    `ExecStart=/usr/bin/node bin/gateway.js`,
    `WorkingDirectory=%h/trust-gateway`,
    `Environment=PORT=${p}`,
    `# EnvironmentFile holds secrets (bot tokens, TG_LLM_KEY). Keep it OUT of`,
    `# git: data/ is gitignored, so data/gateway.env is ignored by default.`,
    `# It must contain ONLY placeholder-free real values you set yourself.`,
    `# Expected keys (see deploy/cloud.md): ${Object.values(PLACEHOLDERS).join(', ')}`,
    `EnvironmentFile=%h/trust-gateway/${envFile}`,
    'Restart=on-failure',
    'RestartSec=5',
    '',
    '# ── Hardening (uncomment to tighten; verified against this app layout) ──',
    '# NoNewPrivileges=yes',
    '# ProtectSystem=strict',
    '# ProtectHome=read-only',
    '# ReadWritePaths=%h/trust-gateway/data',
    '# PrivateTmp=yes',
    '# RestrictSUIDSGID=yes',
    '# CapabilityBoundingSet=',
    '',
    '[Install]',
    'WantedBy=default.target',
    '',
  ].join('\n');
}

function renderPwaShortcut({ url = 'http://127.0.0.1:8787' } = {}) {
  const u = String(url).replace(/"/g, '%22');
  const desktop = [
    '[Desktop Entry]',
    'Type=Application',
    'Name=Trust Gateway (PWA)',
    'Comment=Open the Trust Gateway console as a PWA',
    `Exec=xdg-open ${u}`,
    'Icon=utilities-terminal',
    'Terminal=false',
    'Categories=Network;Development;',
    'NoDisplay=false',
    '',
  ].join('\n');

  const instructions = [
    'Windows: open the gateway URL in Chrome/Edge → menu ⋮ → "Cast, save and',
    'share" → "Install page as app" (or Settings → Install). A Start-menu',
    'shortcut is created automatically; pin it to the taskbar if you like.',
    '',
    'macOS: open the URL in Safari (14+) or Chrome. Chrome: menu → "Install',
    `Page as App" for ${u}. Safari: File → "Add to Dock…" and tick "Open as`,
    'window". The app opens in its own window, independent of browser tabs.',
    '',
    'Linux: save the generated .desktop entry to',
    '~/.local/share/applications/trust-gateway.desktop, then',
    '`update-desktop-database ~/.local/share/applications` (optional).',
  ].join('\n');

  return { desktop, instructions };
}

// Operator snapshot. NEVER include secret values: envSet is booleans only.
function statusReport(gw) {
  const chain = gw.chain;
  const mem = process.memoryUsage();
  return {
    node: process.version,
    platform: process.platform,
    arch: process.arch,
    uptimeSec: Math.round(process.uptime()),
    memoryMB: Math.round(mem.rss / (1024 * 1024)),
    chainLength: chain && chain.entries ? chain.entries.length : 0,
    storage: chain && chain.constructor.name === 'SqlChain' ? 'sqlite' : 'jsonl',
    fts: !!(chain && chain.fts === true),
    mounts: (gw.mounts || []).map((m) => m.name),
    bots: Object.keys(gw.bots || {}).length,
    envSet: {
      TG_TTS_URL: !!process.env.TG_TTS_URL,
      TG_LLM_BASE_URL: !!process.env.TG_LLM_BASE_URL,
      TG_LLM_KEY: !!process.env.TG_LLM_KEY,
      TG_DEPLOY_MODE: !!process.env.TG_DEPLOY_MODE,
    },
  };
}

// Deploy-mode heuristic, surfaced in the console UI only.
// NEVER a security decision: it classifies nothing, authorizes nothing, and
// any of its branches can be wrong (containers, custom inits, remote desktops).
function detectMode(env = process.env) {
  const forced = env.TG_DEPLOY_MODE;
  if (forced === 'desktop' || forced === 'cloud' || forced === 'local-server') {
    return forced;
  }
  let systemd = false;
  try {
    systemd = require('node:fs').readFileSync('/proc/1/comm', 'utf8').trim() === 'systemd';
  } catch { /* non-Linux or restricted: treat as not systemd */ }
  if (env.SSH_CONNECTION) return 'cloud';
  if (systemd) return 'desktop';
  return 'local-server';
}

module.exports = {
  PLACEHOLDERS,
  renderService,
  renderPwaShortcut,
  statusReport,
  detectMode,
};