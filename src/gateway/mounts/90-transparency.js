'use strict';
// mount: D3 transparent deep-chat browsing — server-rendered, human-readable
// transcript pages at /h.
//
//   GET /h/<token>   PUBLIC, no auth — the "fully viewable" transparency
//                    feature. token = first 8 hex chars of
//                    sha256(sessionName + ':' + secret), where secret =
//                    env TG_TRANSPARENCY_SECRET (fallback: chainId). Anyone
//                    holding the link can read the whole session: title,
//                    every turn, and every governed action (decision, result,
//                    approval id + resolved state) reconstructed from the
//                    audit chain.
//   GET /h           operator-only (Bearer, role 'operator') — index of the
//                    last 20 sessions with their public links.
//
// Accepted transparency tradeoff (documented deliberately): the session
// title/name is shown on the public page. The whole point of the feature is
// that a human can verify what a session did, and an anonymous hash gives
// no context. Nothing else secret is ever rendered: no bot tokens, no
// argument values (the chain only stores argsLength), no secret material.
//
// Anti-enumeration: an unknown session and an invalid token render the
// EXACT same bytes — a single constant 404 document with zero request
// influence. An attacker cannot tell "wrong token" from "no such session".
//
// Security notes:
//  - Every dynamic string passes through esc() (& < > " ').
//  - No client JS: single self-contained HTML page, plain markup + inline
//    <style> only (the site CSP is script-src 'self'; we ship no scripts).
//  - <meta name="robots" content="noindex,nofollow"> — transparency is for
//    humans with a link, not for search engines.
//  - No new audit types are emitted (docs/standards/TRANSPARENCY.md gate).
//    Only the pre-existing 'auth_rejected' is audited for index denials,
//    mirroring the mount runner.

const crypto = require('node:crypto');
const { send } = require('../server');
const { getPlanner } = require('../chat-singleton');

const TOKEN_RE = /^[0-9a-f]{8}$/;
const INDEX_LIMIT = 20;

// ── helpers (exported for tests) ───────────────────────────────────────────

// Escape ALL dynamic text. Covers & < > " ' so values are safe both in text
// nodes and inside double-quoted attributes.
function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

function transparencyToken(sessionName, secretValue) {
  return crypto
    .createHash('sha256')
    .update(String(sessionName) + ':' + String(secretValue))
    .digest('hex')
    .slice(0, 8);
}

// Per-gateway secret: env wins, chainId is the stable fallback.
function secretFor(gw) {
  const env = process.env.TG_TRANSPARENCY_SECRET;
  if (typeof env === 'string' && env.length > 0) return env;
  const chain = gw.chain || {};
  if (typeof chain.chainId === 'string' && chain.chainId) return chain.chainId;
  const v = typeof chain.verify === 'function' ? chain.verify() : null;
  return (v && v.chainId) || 'unset';
}

// Constant-time compare of two equal-length hex strings (tokens are padded
// to a fixed width so timingSafeEqual never throws on length mismatch).
function tokenEqual(a, b) {
  const ab = Buffer.from(String(a).padEnd(64, '0'));
  const bb = Buffer.from(String(b).padEnd(64, '0'));
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

// Humanized timestamp: "2026-09-03 12:34:56 UTC" (deterministic: UTC).
function humanTime(ts) {
  const n = Number(ts);
  if (!Number.isFinite(n)) return 'unknown time';
  return new Date(n).toISOString().replace('T', ' ').slice(0, 19) + ' UTC';
}

// ── page shell ─────────────────────────────────────────────────────────────

const STYLE = `
  :root { color-scheme: light; }
  * { box-sizing: border-box; }
  body { margin:0; font:15px/1.55 ui-sans-serif,system-ui,-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;
         background:#f6f7f9; color:#1f2328; padding:28px 20px 60px; }
  main { max-width: 880px; margin: 0 auto; }
  h1 { font-size: 22px; margin: 0 0 2px; word-break: break-word; }
  h2 { font-size: 15px; text-transform: uppercase; letter-spacing: .06em; color:#59636e; margin: 34px 0 10px; }
  .sub { color:#59636e; margin-bottom: 6px; font-size: 14px; }
  .note { background:#fff8e6; border:1px solid #e8d59a; border-radius:8px; padding:10px 14px;
          font-size:13px; color:#6a5514; margin: 14px 0 4px; }
  .turn { background:#ffffff; border:1px solid #d8dee4; border-radius:10px; padding:12px 16px; margin:10px 0; }
  .turn .meta { font-size:12px; color:#59636e; margin-bottom:6px; }
  .turn .who { font-weight:600; color:#1f2328; }
  .turn.assistant { border-left:4px solid #4c8bf5; }
  .turn.user { border-left:4px solid #a5aeb8; }
  .text { white-space: pre-wrap; word-break: break-word; font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 13.5px; }
  table { width:100%; border-collapse: collapse; background:#ffffff; border:1px solid #d8dee4; border-radius:10px; overflow:hidden; }
  th, td { text-align:left; padding:8px 10px; border-bottom:1px solid #eaeef2; font-size:13px; vertical-align:top; }
  th { color:#59636e; font-size:11px; text-transform:uppercase; letter-spacing:.06em; background:#f6f8fa; }
  .badge { display:inline-block; padding:2px 9px; border-radius:10px; font-size:11.5px; font-weight:600; }
  .badge.allow { background:#dafbe1; color:#116329; }
  .badge.needs_approval { background:#fff8c5; color:#7a5c00; }
  .badge.deny { background:#ffebe9; color:#a40e26; }
  .mono { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size:12px; word-break: break-all; }
  .muted { color:#59636e; }
  code { background:#eff2f5; border-radius:4px; padding:1px 5px; font-size:12.5px; }
  a { color:#255ab5; }
  .foot { margin-top:26px; font-size:12px; color:#59636e; }
`;

function page(title, bodyHtml) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow">
<title>${esc(title)}</title>
<style>${STYLE}</style>
</head>
<body><main>
${bodyHtml}
<div class="foot">Trust Gateway · transparency transcript — rendered server-side from the sealed audit chain. No scripts, no tracking.</div>
</main></body>
</html>
`;
}

// Byte-identical for every rejection: unknown session OR invalid token OR bad
// shape. Zero interpolation of request data — anti-enumeration by construction.
const NOT_FOUND_HTML = page('Not found', `
<h1>Not found</h1>
<p class="sub">This transcript is not available.</p>
<p class="muted">Transcript links look like <code>/h/&lt;8 hex chars&gt;</code> and come from an operator. If you got this link from a person, the session may have ended or the link may be mistyped.</p>
`);

// ── action reconstruction from the chain ───────────────────────────────────
// ChatPlanner/LlmBrain audit 'chat_action' rows carrying {session, bot, tool,
// decision}; the follow-ups ('approval_requested', 'chat_action_executed',
// 'action_executed_after_approval', 'approval_resolved') have no session
// field, so we join them back to the most recent open row for the same
// bot+tool. 'chat_llm' is scanned too (defensive — reserved payload shape).
function collectActions(gw, sessionName) {
  const rows = [];
  const openByTool = new Map(); // "bot|tool" -> latest row awaiting join
  for (const e of gw.chain.entries) {
    const p = e.payload || {};
    const key = String(p.bot || '') + '|' + String(p.tool || '');
    if ((p.type === 'chat_action' || p.type === 'chat_llm') && p.session === sessionName) {
      const row = {
        seq: e.seq, ts: e.ts, bot: p.bot || '', tool: p.tool || '',
        decision: p.decision || '', class: p.class || '',
        source: p.source || 'planner',
        approvalId: null, approvalState: '', result: '',
      };
      rows.push(row);
      openByTool.set(key, row);
    } else if (p.type === 'approval_requested') {
      const row = openByTool.get(key);
      if (row && row.decision === 'needs_approval' && row.approvalId === null) {
        row.approvalId = p.approvalId;
        row.approvalState = 'pending';
      }
    } else if (p.type === 'chat_action_executed') {
      const row = openByTool.get(key);
      if (row && !row.result) {
        row.result = p.ok ? 'executed — ok' : 'dispatch failed';
        if (!p.ok && p.error) row.result += ' (' + String(p.error).slice(0, 160) + ')';
      }
    } else if (p.type === 'action_executed_after_approval') {
      const row = rows.find((r) => r.approvalId && r.approvalId === p.approvalId);
      if (row) row.result = (row.result ? row.result + ' · ' : '') + (p.ok ? 'executed after approval' : 'failed after approval');
    } else if (p.type === 'approval_resolved') {
      const row = rows.find((r) => r.approvalId && r.approvalId === p.approvalId);
      if (row) row.approvalState = p.verb === 'approve' ? 'approved' : (p.verb === 'deny' ? 'denied' : String(p.verb));
    }
  }
  // Supplement from the planner store: use governance summaries stored
  // by registerTurn so brain/loop sessions are fully visible even if
  // the audit chain entry is missing or incomplete.
  try {
    const planner = getPlanner(gw);
    const ps = planner.sessions.get(sessionName);
    if (ps) {
      for (const h of ps.history) {
        if (!h.governance || !h.governance.tools.length) continue;
        const already = rows.some((r) => r.tool === h.governance.tools[0] && r.bot === h.governance.bot);
        if (!already) {
          rows.push({
            seq: h.ts, ts: h.ts, bot: h.governance.bot || '', tool: h.governance.tools[0] || '',
            decision: h.governance.decisions[0] || '', class: '',
            source: h.governance.source || 'planner',
            approvalId: null, approvalState: '', result: '',
          });
        }
      }
    }
  } catch { /* planner not available — rely on audit chain only */ }
  // The live approval store is the source of truth for current state
  // (covers expiry and any resolution that happened after the chain scan).
  for (const r of rows) {
    if (!r.approvalId || !gw.approvals || typeof gw.approvals.get !== 'function') continue;
    const rec = gw.approvals.get(r.approvalId);
    if (rec && rec.status) r.approvalState = rec.status;
  }
  return rows;
}

// ── renderers ──────────────────────────────────────────────────────────────

function transcriptHtml(sessionName, session, rows, verdict) {
  const v = verdict;
  const turns = (session.history || []).map((h) => `
<div class="turn ${esc(h.role === 'assistant' ? 'assistant' : 'user')}">
  <div class="meta"><span class="who">${esc(h.role === 'assistant' ? 'bot' : h.role)}</span> · ${esc(humanTime(h.ts))}</div>
  <div class="text">${esc(h.text)}</div>
</div>`).join('');
  const actionRows = rows.length
    ? rows.map((r) => `
<tr>
  <td class="muted">${esc(humanTime(r.ts))}</td>
  <td><span class="mono">${esc(r.tool)}</span><br><span class="muted">by ${esc(r.bot)} · ${esc(r.source)}</span></td>
  <td><span class="badge ${esc(r.decision)}">${esc(r.decision)}</span><br><span class="muted">${esc(r.class || '')}</span></td>
  <td>${esc(r.result || '—')}</td>
  <td class="mono">${esc(r.approvalId || '—')}</td>
  <td>${esc(r.approvalState || '—')}</td>
</tr>`).join('')
    : '<tr><td colspan="6" class="muted">no actions proposed in this session</td></tr>';
  return page(`Session · ${sessionName}`, `
<h1>${esc(sessionName)}</h1>
<div class="sub">Started ${esc(humanTime(session.created))} · ${esc(String((session.history || []).length))} turns · chain ${v.ok ? 'SEALED' : 'TAMPERED'} (${esc(String(v.length))} entries)</div>
<div class="note"><b>Why you can read this:</b> this gateway runs in full-transparency mode — the session title is shown on purpose so any human holding the link can verify what was said and decided. Bot tokens and tool arguments are never rendered.</div>
<h2>Conversation</h2>
${turns || '<p class="muted">no turns recorded</p>'}
<h2>Governed actions</h2>
<table>
<thead><tr><th>Time</th><th>Tool</th><th>Decision</th><th>Result</th><th>Approval</th><th>State</th></tr></thead>
<tbody>${actionRows}</tbody>
</table>
`);
}

function indexHtml(gw, sessions, sec) {
  const last = sessions.slice(-INDEX_LIMIT); // most recent 20 (insertion order)
  const rows = last.map((s) => {
    const full = (getPlanner(gw).sessions.get(s.name) || {}).history || [];
    return `
<tr>
  <td><a class="mono" href="/h/${esc(transparencyToken(s.name, sec))}">${esc(s.name)}</a></td>
  <td class="muted">${esc(humanTime(s.created))}</td>
  <td>${esc(String(s.turns))}</td>
  <td class="muted">${esc(String(full.length))}</td>
  <td class="mono">${esc(transparencyToken(s.name, sec))}</td>
</tr>`;
  }).join('');
  return page('Session index', `
<h1>Transparency index</h1>
<div class="sub">Last ${esc(String(last.length))} chat sessions of ${esc(String(sessions.length))} total — operator view.</div>
<table>
<thead><tr><th>Session</th><th>Created</th><th>User turns</th><th>History rows</th><th>Public token</th></tr></thead>
<tbody>${rows || '<tr><td colspan="5" class="muted">no sessions yet</td></tr>'}</tbody>
</table>
`);
}

// ── the mount ──────────────────────────────────────────────────────────────

module.exports = {
  name: 'transparency',
  method: 'GET',
  path: /^\/h(?:\/([^/?]*))?$/,
  auth: 'none', // public by design; the index performs bearer auth in-handler
  esc, transparencyToken, secretFor, humanTime, collectActions,
  handle: async (gw, req, res, ctx) => {
    const seg = ctx.params.matches[1];

    // ── GET /h — operator-only index ──
    if (seg === undefined) {
      const bot = gw._auth(req);
      if (!bot) {
        gw._audit({ type: 'auth_rejected', path: '/h' });
        return send(res, 401, { error: 'unauthorized' });
      }
      if ((bot.role || '') !== 'operator') return send(res, 403, { error: 'operator_required' });
      const planner = getPlanner(gw);
      return send(res, 200, null, { html: indexHtml(gw, planner.listSessions(), secretFor(gw)) });
    }

    // ── GET /h/<token> — public transcript ──
    const notFound = () => send(res, 404, null, { html: NOT_FOUND_HTML });
    if (!TOKEN_RE.test(seg)) return notFound();
    const sec = secretFor(gw);
    const planner = getPlanner(gw);
    let sessionName = null;
    for (const s of planner.listSessions()) {
      if (tokenEqual(transparencyToken(s.name, sec), seg) && sessionName === null) sessionName = s.name;
    }
    if (sessionName === null) return notFound();
    const session = planner.sessions.get(sessionName);
    if (!session) return notFound();
    const rows = collectActions(gw, sessionName);
    let verdict;
    try { verdict = gw.chain.verify(); } catch { verdict = { ok: false, length: 0 }; }
    return send(res, 200, null, { html: transcriptHtml(sessionName, session, rows, verdict) });
  },
};
