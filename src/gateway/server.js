'use strict';
// Trust Gateway — HTTP API. Write-ahead audit: the decision is recorded
// BEFORE any dispatcher runs, so refusals and crashes are on the record too.

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { HashChain } = require('./hash-chain');
const { classify, decide } = require('./policy');
const { computeImpact } = require('./impact');
const { ApprovalStore } = require('./approvals');
const { MemoryStore, getMemoryStore } = require('./memory');
const disk = require('./disk-audit');
const { loadMounts, match } = require('./http-mounts');

const MAX_BODY = 256 * 1024;

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(new Error('body_too_large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function send(res, status, obj, extra = {}) {
  if (extra.html !== undefined) {
    res.writeHead(status, { 'content-type': 'text/html; charset=utf-8' });
    return res.end(extra.html);
  }
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(body);
}

class Gateway extends EventEmitter {
  constructor({
    bots = {},            // name -> { token, capabilities, role }
    dispatch = null,      // async (bot, tool, args) -> result object
    chain = null,
    approvals = null,
    now = () => Date.now(),
    auditFile = null,     // path -> durable append-only JSONL audit
    approvalsFile = null, // path -> durable approvals (pending survive restart)
    mountFiles = true,    // v2: load src/gateway/mounts/*.js plugin routes
    staticDir = null,     // v2: serve SPA from this dir at /
    marketingDir = null,  // v2: serve public site from this dir at /home
    botsDir = null,       // wave C: jails root, available to mount-declared executors
  } = {}) {
    super();
    this.bots = bots;
    this.dispatch = dispatch;
    this.auditFd = null;
    this.marketingDir = marketingDir;
    if (auditFile) {
      const { chain: loaded } = disk.loadChain(auditFile);
      this.chain = chain ?? loaded;
      this.auditFd = disk.openAppendFd(auditFile);
    } else {
      this.chain = chain ?? new HashChain();
    }
    this.approvals = approvals ?? new ApprovalStore({ now, file: approvalsFile, gw: this });
    this.memory = getMemoryStore(this);
    this.now = now;
    this.mounts = mountFiles ? loadMounts() : [];
    this.staticDir = staticDir ?? null;
    this.botsDir = botsDir;
    this._executors = []; // v2 wave B: {re, fn(bot,tool,args)} for synthetic tools
    // wave C convention: a mount file may ALSO export executors:[{re, make(gw)}]
    // so new tool namespaces never touch bin/gateway.js (single-writer rule).
    for (const m of this.mounts) {
      if (Array.isArray(m.executors)) {
        for (const e of m.executors) {
          if (e.re instanceof RegExp && typeof e.make === 'function') {
            this.registerExecutor(e.re, e.make(this));
          }
        }
      }
    }
  }

  // Register a handler for a synthetic tool namespace (e.g. /^harness\.run:/).
  // Unknown tools classify as destructive → approval → executor runs AFTER
  // approval; executor results reuse the action_executed audit vocabulary.
  registerExecutor(re, fn) {
    if (!(re instanceof RegExp) || typeof fn !== 'function') throw new Error('registerExecutor(re,fn)');
    this._executors.push({ re, fn });
  }

  _findExecutor(tool) {
    for (const e of this._executors) if (e.re.test(tool)) return e.fn;
    return null;
  }

  // Resolution order: registered executor wins (synthetic v2 tools), else the
  // configured dispatcher (jailed fs/shell). Errors propagate to call sites.
  async _run(botName, tool, args) {
    const exec = this._findExecutor(tool);
    if (exec) return exec(botName, tool, args);
    if (!this.dispatch) throw new Error('no_dispatcher');
    return this.dispatch(botName, tool, args);
  }

  _auth(req) {
    const h = req.headers['authorization'] || '';
    const m = /^Bearer\s+(.+)$/i.exec(h);
    if (!m) return null;
    const token = m[1];
    for (const [name, bot] of Object.entries(this.bots)) {
      if (bot.token && cryptoSafeEqual(bot.token, token)) return { name, ...bot };
    }
    return null;
  }

  _audit(payload) {
    const entry = this.chain.append(payload, this.now());
    // Durable write-ahead: the seal hits disk before we ever dispatch.
    if (this.auditFd !== null) disk.appendTo(this.auditFd, entry);
    this.emit('audit', entry); // v2: SSE hub listens
    return entry;
  }

  async handle(req, res) {
    const url = new URL(req.url, 'http://localhost');
    const pathname = url.pathname;

    // ── v2 static SPA (dashboard) + PWA assets + panels ──
    if (this.staticDir && req.method === 'GET') {
      // Phase 2 (§20.3): the 9 domain URIs resolve to the console shell.
      if (/^\/(now|chat|work|agents|brain|output|control|connect|system)\/?$/.test(pathname)) {
        return this._serveStatic(res, 'index.html');
      }
      const rel = pathname === '/' ? 'index.html'
        : /^(\/(app\.js|keys\.js|compose\.js|style\.css|index\.html|sw\.js|offline\.html|pwa-head\.html|manifest\.webmanifest|responsive\.css|desktop\.css|favicon\.svg))$/.test(pathname) ? pathname.slice(1)
        : /^\/icons\/[\w.-]+\.svg$/.test(pathname) ? pathname.slice(1)
        : /^\/panels\/[\w.-]+\.js$/.test(pathname) ? pathname.slice(1)
        : null;
      if (rel) return this._serveStatic(res, rel);
    }

    // ── v2 marketing site at /home (separate dir, no auth — public content) ──
    if (this.marketingDir && req.method === 'GET' && (pathname === '/home' || pathname === '/home/')) {
      return this._serveStaticFrom(this.marketingDir, res, 'index.html');
    }
    if (this.marketingDir && req.method === 'GET' && pathname.startsWith('/home/')) {
      return this._serveStaticFrom(this.marketingDir, res, pathname.slice('/home/'.length));
    }

    // ── v2 plugin mounts (before v1 auth; each mount declares its auth mode) ──
    for (const mount of this.mounts) {
      const params = match(mount, req.method, pathname);
      if (!params) continue;
      let bot = null;
      if (mount.auth === 'bearer') {
        bot = this._auth(req);
        if (!bot) { this._audit({ type: 'auth_rejected', path: pathname }); return send(res, 401, { error: 'unauthorized' }); }
      } else if (mount.auth === 'query') {
        const token = url.searchParams.get('token') || '';
        bot = this._auth({ headers: { authorization: token ? `Bearer ${token}` : '' } });
        if (!bot) { this._audit({ type: 'auth_rejected', path: pathname }); return send(res, 401, { error: 'unauthorized' }); }
      }
      return mount.handle(this, req, res, { url, params, bot });
    }

    if (req.method === 'GET' && !this.staticDir && (pathname === '/' || pathname === '/dashboard')) {
      return send(res, 200, null, { html: this.dashboardHtml() });
    }

    if (req.method === 'GET' && pathname === '/healthz') {
      return send(res, 200, { ok: true, chain: this.chain.verify() });
    }

    // Everything else requires auth.
    const bot = this._auth(req);
    if (!bot) {
      this._audit({ type: 'auth_rejected', path: pathname });
      return send(res, 401, { error: 'unauthorized' });
    }
    const path = pathname; // legacy handlers below use `path`

    if (req.method === 'POST' && path === '/v1/actions') {
      return this._postAction(req, res, bot);
    }
    if (req.method === 'POST' && /^\/v1\/approvals\/[^/]+\/(approve|deny)$/.test(path)) {
      return this._postApproval(req, res, bot, path);
    }
    if (req.method === 'GET' && path === '/v1/approvals') {
      const pending = this.approvals.listPending().map((r) => ({
        id: r.id, bot: r.bot, tool: r.tool, reason: r.reason,
        createdAt: r.createdAt, expiresAt: r.expiresAt,
      }));
      return send(res, 200, { pending });
    }
    if (req.method === 'GET' && path === '/v1/audit') {
      const since = Number(url.searchParams.get('since') || 0);
      const entries = this.chain.since(since);
      return send(res, 200, { entries, head: this.chain.head.hash, verified: this.chain.verify() });
    }
    if (req.method === 'GET' && path === '/v1/audit/verify') {
      return send(res, 200, this.chain.verify());
    }
    return send(res, 404, { error: 'not_found' });
  }

  dashboardHtml() {
    const v = this.chain.verify();
    const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    const rows = this.chain.entries.slice().reverse().slice(0, 50).map((e) => {
      const p = e.payload;
      const cls = { action_decision: 'decision', action_executed: 'exec', approval_requested: 'approval', approval_resolved: 'approval', auth_rejected: 'deny', action_executed_after_approval: 'exec' }[p.type] || 'other';
      const detail = p.tool ? `${esc(p.tool)}` : esc(p.type);
      const who = p.bot || p.approver || '';
      const dec = p.decision || (p.type === 'approval_resolved' ? p.verb : '');
      return `<tr><td>${e.seq}</td><td><span class="tag ${cls}">${esc(p.type)}</span></td><td>${esc(who)}</td><td>${detail}</td><td>${esc(dec)}</td><td class="hash" title="${e.hash}">${e.hash.slice(0, 12)}…</td></tr>`;
    }).join('');
    const bots = Object.entries(this.bots).map(([n, b]) =>
      `<div class="bot"><b>${esc(n)}</b><span class="muted">caps: ${esc((b.capabilities || []).join(', ') || 'none')}</span></div>`).join('');
    return `<!doctype html><html><head><meta charset="utf-8"><title>Trust Gateway</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body { margin:0; font:14px/1.5 ui-monospace,Menlo,Consolas,monospace; background:#0b0e14; color:#c9d1d9; padding:24px; }
  h1 { font-size:18px; margin:0 0 4px; color:#e6edf3; }
  .sub { color:#8b949e; margin-bottom:20px; }
  .cards { display:flex; gap:12px; flex-wrap:wrap; margin-bottom:20px; }
  .card { background:#11151f; border:1px solid #21262d; border-radius:8px; padding:12px 16px; min-width:180px; }
  .card .k { color:#8b949e; font-size:11px; text-transform:uppercase; letter-spacing:.08em; }
  .card .v { font-size:20px; color:#58d68d; margin-top:2px; }
  .card.warn .v { color:#e3b341; }
  .bot { background:#11151f; border:1px solid #21262d; border-radius:8px; padding:10px 14px; margin:0 12px 8px 0; display:inline-block; }
  .bot .muted { display:block; color:#8b949e; font-size:11px; margin-top:2px; }
  table { width:100%; border-collapse:collapse; background:#11151f; border:1px solid #21262d; border-radius:8px; overflow:hidden; }
  th,td { text-align:left; padding:7px 10px; border-bottom:1px solid #21262d; }
  th { color:#8b949e; font-size:11px; text-transform:uppercase; letter-spacing:.08em; }
  .tag { padding:2px 8px; border-radius:10px; font-size:11px; }
  .tag.decision { background:#1c2a3a; color:#79c0ff; }
  .tag.exec { background:#12331f; color:#58d68d; }
  .tag.approval { background:#332a12; color:#e3b341; }
  .tag.deny { background:#3a1c1c; color:#f85149; }
  .muted { color:#8b949e; }
  .hashcell, td.hash { color:#8b949e; font-size:11px; }
  .foot { margin-top:14px; color:#8b949e; font-size:11px; }
  .ok { color:#58d68d; } .bad { color:#f85149; }
</style></head><body>
<h1>▲ Trust Gateway</h1>
<div class="sub">Governed AI workforce — every action decided before it happens, sealed after.</div>
<div class="cards">
  <div class="card"><div class="k">Audit chain</div><div class="v ${v.ok ? 'ok' : 'bad'}">${v.ok ? 'SEALED ✓' : 'TAMPERED'}</div></div>
  <div class="card"><div class="k">Entries</div><div class="v">${v.length}</div></div>
  <div class="card warn"><div class="k">Bots</div><div class="v">${Object.keys(this.bots).length}</div></div>
  <div class="card"><div class="k">Chain ID</div><div class="v" style="font-size:11px">${esc(v.chainId)}</div></div>
</div>
<div style="margin-bottom:16px">${bots}</div>
<table><thead><tr><th>#</th><th>Event</th><th>Bot</th><th>Tool</th><th>Decision</th><th>Seal</th></tr></thead>
<tbody>${rows || '<tr><td colspan="6" class="muted">no entries yet</td></tr>'}</tbody></table>
<div class="foot">Head ${esc(v.head)} — chain verified at page load. API: <a style="color:#79c0ff" href="/healthz">/healthz</a> · <a style="color:#79c0ff" href="/v1/audit/verify">/v1/audit/verify</a></div>
<script>setTimeout(()=>location.reload(), 15000);</script>
</body></html>`;
  }

  _serveStatic(res, rel) {
    return this._serveStaticFrom(this.staticDir, res, rel);
  }

  _serveStaticFrom(dir, res, rel) {
    const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.webmanifest': 'application/manifest+json' };
    const file = path.join(dir, rel);
    if (!file.startsWith(path.resolve(dir) + path.sep) && file !== path.resolve(dir)) {
      return send(res, 400, { error: 'bad_path' });
    }
    try {
      let data = fs.readFileSync(file);
      if (dir === this.marketingDir && rel.endsWith('.html')) {
        // rewrite relative asset refs so /home/* is self-contained
        data = Buffer.from(
          data.toString('utf8')
            .replace(/href="style\.css"/g, 'href="/home/style.css"')
            .replace(/href="styles\.css"/g, 'href="/home/styles.css"')
            .replace(/src="app\.js"/g, 'src="/home/app.js"'));
      }
      res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream' });
      res.end(data);
    } catch {
      if (rel === 'index.html' && dir === this.staticDir) return send(res, 200, null, { html: this.dashboardHtml() }); // v1 fallback
      send(res, 404, { error: 'not_found' });
    }
  }

  async _postAction(req, res, bot) {
    let body;
    try {
      body = JSON.parse(await readBody(req));
    } catch (e) {
      return send(res, 400, { error: 'invalid_json' });
    }
    const tool = body.tool;
    const args = body.args ?? null;
    const cls = classify(tool);
    const verdict = decide({ tool, cls, bot });

    // Write-ahead audit of the DECISION.
    const auditPayload = {
      type: 'action_decision',
      bot: bot.name,
      tool,
      class: cls,
      decision: verdict.decision,
      reason: verdict.reason,
      // Never store secret values; store length only.
      argsLength: args === undefined || args === null ? 0 : JSON.stringify(args).length,
    };
    this._audit(auditPayload);

    if (verdict.decision === 'deny') {
      return send(res, 403, { ...verdict, audited: true });
    }
    if (verdict.decision === 'needs_approval') {
      const approval = this.approvals.request({
        bot,
        tool,
        args,
        reason: verdict.reason,
      });
      this._audit({ type: 'approval_requested', approvalId: approval.id, bot: bot.name, tool, class: cls });
      // Audit the deterministic impact snapshot — never the raw args.
      this._audit({
        type: 'approval_impact_snapshot',
        approvalId: approval.id,
        risk: approval.impact ? approval.impact.risk : 'destructive',
        confidence: approval.impact ? approval.impact.confidence : 'missing',
      });
      return send(res, 202, { decision: 'needs_approval', approvalId: approval.id, reason: verdict.reason });
    }

    // allow → execute (executor wins for synthetic tools, else jailed dispatch)
    if (!this.dispatch && !this._findExecutor(tool)) return send(res, 500, { error: 'no_dispatcher' });
    try {
      const result = await this._run(bot.name, tool, args);
      this._audit({ type: 'action_executed', bot: bot.name, tool, ok: true });
      return send(res, 200, { decision: 'allow', result });
    } catch (e) {
      this._audit({ type: 'action_executed', bot: bot.name, tool, ok: false, error: String(e && e.message) });
      return send(res, 502, { decision: 'allow', error: 'dispatch_failed' });
    }
  }

  async _postApproval(req, res, bot, path) {
    const m = path.match(/^\/v1\/approvals\/([^/]+)\/(approve|deny)$/);
    const [, id, verb] = m;

    // RBAC: only operators may approve/deny. Capture the tool for the audit
    // entry BEFORE the failure response, so we can record what was denied
    // without leaking args.
    const parked = this.approvals.get(id);
    const parkedTool = parked && parked.status === 'pending' ? parked.tool : null;
    if (!canApprove(bot)) {
      this._audit({
        type: 'approval_forbidden',
        approvalId: id,
        bot: bot.name,
        tool: parkedTool,
      });
      return send(res, 403, { error: 'operator_required' });
    }

    const approver = bot.name;
    const parkedAction = parked && parked.status === 'pending' ? { tool: parked.tool, args: parked.args } : null;
    const result = this.approvals.resolve(id, verb, approver);
    this._audit({
      type: 'approval_resolved',
      approvalId: id,
      verb,
      approver,
      ok: result.ok,
      error: result.ok ? undefined : result.error,
    });
    if (!result.ok) {
      const status = result.error === 'not_found' ? 404 : 409;
      return send(res, status, result);
    }
    if (verb === 'deny') return send(res, 200, { id, status: 'denied' });

    // Approved → execute the parked decision (survives restart via durable store).
    if (!parkedAction) return send(res, 500, { error: 'parked_action_missing' });
    if (!this.dispatch && !this._findExecutor(parkedAction.tool)) return send(res, 500, { error: 'no_dispatcher' });
    try {
      const out2 = await this._run(bot.name, parkedAction.tool, parkedAction.args);
      this._audit({ type: 'action_executed_after_approval', approvalId: id, tool: parkedAction.tool, ok: true });
      return send(res, 200, { id, status: 'approved', result: out2 });
    } catch (e) {
      this._audit({ type: 'action_executed_after_approval', approvalId: id, tool: parkedAction.tool, ok: false });
      return send(res, 502, { id, status: 'approved', error: 'dispatch_failed' });
    }
  }
}

function cryptoSafeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}
const crypto = require('node:crypto');

// Operator gate for /v1/approvals/:id/approve|deny. A bot may approve if:
//   - it has role === 'operator', OR
//   - it has capability 'approval.decide', OR
//   - it has the wildcard capability '*' (backward-compat admin).
// Everyone else is denied with 403 + an audit entry.
// Args are NEVER read for the denied path — the tool is read from the
// parked record before denial, but args stay on the pending record.
function canApprove(bot) {
  if (!bot) return false;
  if (bot.role === 'operator') return true;
  const caps = Array.isArray(bot.capabilities) ? bot.capabilities : [];
  if (caps.includes('approval.decide')) return true;
  if (caps.includes('*')) return true;
  return false;
}

module.exports = { Gateway, send, readBody, canApprove };