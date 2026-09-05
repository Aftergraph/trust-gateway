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
const { getApprovals } = require('./approvals-db'); // FS-A5: env-gated DB variant
const { MemoryStore, getMemoryStore } = require('./memory');
const { BudgetStore } = require('./budgets');
const { revalidate: aie_revalidate } = require('./aie-client'); // TG → AIE execution-time revalidation
const disk = require('./disk-audit');
const { TelemetryRing, DEFAULT_FILE: DEFAULT_TELEMETRY_FILE } = require('./telemetry');
const { loadMounts, match } = require('./http-mounts');

const MAX_BODY = 256 * 1024;
const DEFAULT_RATE_LIMIT = 60;          // req/min/token - env TG_RATE_LIMIT overrides
const DEFAULT_OPERATOR_MULT = 3;        // operator budget multiplier - env TG_RATE_OPERATOR_MULTIPLIER
const RATE_WINDOW_MS = 60 * 1000;
const MAX_PAGE_LIMIT = 5000;

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
    budgets = null,       // v2 Slice 2: BudgetStore instance, or null (feature off)
    mountFiles = true,    // v2: load src/gateway/mounts/*.js plugin routes
    staticDir = null,     // v2: serve SPA from this dir at /
    marketingDir = null,  // v2: serve public site from this dir at /home
    botsDir = null,       // wave C: jails root, available to mount-declared executors
    delegationChainFile = null, // optional durable A2A delegation graph path
    delegationChainTenantId = null, // derive durable graph path from tenant scope
    telemetryFile,        // G12: telemetry ring file (default data/telemetry.json; null = memory-only)
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
    // FS-A5: env-gated SQLite approvals (TG_APPROVALS_DB=1); env unset → the
    // legacy JSON-backed ApprovalStore, byte-identical (WeakMap-cached per gw).
    this.approvals = approvals ?? getApprovals(this, { now, file: approvalsFile, gw: this });
    this.memory = getMemoryStore(this);
    // G12 (§20.4): telemetry ring — observability, NOT the audit chain.
    this.telemetry = new TelemetryRing({ file: telemetryFile !== undefined ? telemetryFile : DEFAULT_TELEMETRY_FILE, now });
    this.budgets = budgets ?? null; // v2 Slice 2: opt-in; null => feature off => zero behavior change
    this.now = now;
    this.mounts = mountFiles ? loadMounts() : [];
    // Function-style mounts (120+): wire via gw.router facade. Each mount is
    // called once with (gw) and registers routes on this._fnRoutes.
    this._fnRoutes = [];
    if (mountFiles) {
      const skippedFn = [];
      for (const f of fs.readdirSync(path.join(__dirname, 'mounts')).sort()) {
        if (!f.endsWith('.js')) continue;
        try {
          const m = require(path.join(__dirname, 'mounts', f));
          if (typeof m === 'function') skippedFn.push(f);
        } catch { /* loader already validated the object-style ones */ }
      }
      if (skippedFn.length > 0) {
        this.router = this._makeRouter();
        // Point route registration at the live route list
        for (const verb of ['get', 'post', 'put', 'delete', 'patch', 'all']) {
          const method = verb === 'delete' ? 'DELETE' : verb === 'all' ? '*' : verb.toUpperCase();
          this.router[verb] = (p, handler) => { this._fnRoutes.push({ method, path: p, handler }); };
        }
        for (const f of skippedFn) {
          try {
            const m = require(path.join(__dirname, 'mounts', f));
            m(this);
          } catch (e) {
            console.error(`[mounts] function-style mount ${f} failed to wire: ${e.message}`);
          }
        }
      }
    }
    this.staticDir = staticDir ?? null;
    this.botsDir = botsDir;
    this.delegationChainFile = delegationChainFile;
    this.delegationChainTenantId = delegationChainTenantId;
    this._executors = []; // v2 wave B: {re, fn(bot,tool,args)} for synthetic tools
    // Token-bucket per-bot rate limiter (slice: perimeter-guards).
    const envLimit = Number(process.env.TG_RATE_LIMIT);
    this.rateLimit = Number.isFinite(envLimit) && envLimit > 0 ? envLimit : DEFAULT_RATE_LIMIT;
    const envMult = Number(process.env.TG_RATE_OPERATOR_MULTIPLIER);
    this.rateOperatorMult = Number.isFinite(envMult) && envMult > 0 ? envMult : DEFAULT_OPERATOR_MULT;
    this._rateBuckets = new Map(); // token -> { count, windowStart }
    // v2 token-hash: stale digest indices for rotation auditing (A-006).
    this.knownStaleHashes = new Set();
    this.knownStaleByBot = Object.create(null);
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
    // FS-A1 slice 2: tenant-scoped token 'tnt_<tenantId>_<rosterToken>' —
    // match EITHER the full token (spawned tenant gateways put tnt_-prefixed
    // tokens in their roster verbatim) OR the stripped roster part (live env
    // rosters hold plain tokens). Unknown/disabled tenant → 401 fail-closed.
    let candidates = [token];
    const tm = /^tnt_([a-z0-9-]{3,24})_(.+)$/.exec(token);
    if (tm) {
      try {
        const { db } = require('./db');
        const row = db.prepare('SELECT id, disabled FROM tenants WHERE id = ?').get(tm[1]);
        if (!row) return null; // unknown tenant → fail closed
        if (row.disabled) return null; // disabled tenant → fail closed
        candidates.push(tm[2]);
      } catch { /* tenants table missing → treat as no prefix */ }
    }
    for (const [name, bot] of Object.entries(this.bots)) {
      for (const cand of candidates) {
        // wave-B token security: prefer sha256 digest compare (tokenHash at rest,
        // plaintext never stored); plain token still accepted for legacy rosters.
        const presentedHash = hashToken(cand);
        if (bot.tokenHash && cryptoSafeEqual(bot.tokenHash, presentedHash)) {
          if (this.knownStaleHashes && this.knownStaleHashes.has(bot.tokenHash)) {
            this.knownStaleHashes.delete(bot.tokenHash);
            (this.knownStaleByBot[name] || new Set()).delete(bot.tokenHash);
          }
          return { name, ...bot, tenantPrefix: tm ? tm[1] : null };
        }
        if (bot.token && cryptoSafeEqual(bot.token, cand)) {
          return { name, ...bot, tenantPrefix: tm ? tm[1] : null };
        }
      }
    }
    // A-006: stale digest rejection — after rotation the OLD bearer must fail
    // closed with an audited 'token_rejected_stale' naming the bot it belonged to.
    for (const cand of candidates) {
      const staleHash = hashToken(cand);
      for (const [botName, hashes] of Object.entries(this.knownStaleByBot || {})) {
        if (hashes && hashes.has(staleHash)) {
          this._audit({ type: 'token_rejected_stale', bot: botName });
          return null;
        }
      }
    }
    return null;
  }

  _enforceRateLimit(bot) {
    const budget = this.rateLimit * (bot.role === 'operator' ? this.rateOperatorMult : 1);
    const t = this.now();
    let b = this._rateBuckets.get(bot.name);
    if (!b || t - b.windowStart >= RATE_WINDOW_MS) {
      b = { count: 0, windowStart: t };
      this._rateBuckets.set(bot.name, b);
    }
    b.count += 1;
    if (b.count > budget) {
      return { status: 429, body: { error: 'rate_limited' }, remaining: 0, budget };
    }
    return { status: 200, body: null, remaining: budget - b.count, budget };
  }

  _rateSnapshot(botName) {
    const b = this._rateBuckets.get(botName);
    if (!b) return { remaining: null, budget: null, windowStart: null };
    const t = this.now();
    const elapsed = t - b.windowStart;
    if (elapsed >= RATE_WINDOW_MS) return { remaining: null, budget: null, windowStart: null };
    const bot = this.bots[botName] || {};
    const budget = this.rateLimit * (bot.role === 'operator' ? this.rateOperatorMult : 1);
    return { remaining: Math.max(0, budget - b.count), budget, windowStart: b.windowStart };
  }

  // v2 token rotation: retain a digest as 'stale' so subsequent requests
  // with the OLD bearer are audited as 'token_rejected_stale' (A-006).
  _markStale(botName, tokenHash) {
    if (!botName || !tokenHash) return;
    this.knownStaleHashes.add(tokenHash);
    if (!this.knownStaleByBot[botName]) this.knownStaleByBot[botName] = new Set();
    this.knownStaleByBot[botName].add(tokenHash);
  }

  _audit(payload) {
    const entry = this.chain.append(payload, this.now());
    // Durable write-ahead: the seal hits disk before we ever dispatch.
    if (this.auditFd !== null) disk.appendTo(this.auditFd, entry);
    this.emit('audit', entry); // v2: SSE hub listens
    return entry;
  }

  // v2 function-style mounts (120+): gw.router.get(path, handler) registers
  // a handler consulted by handle() BEFORE v1 routes. Handlers receive
  // (req, res, ctx) exactly like object-style mount.handle.
  // Supported verbs: get/post/put/delete/patch/all.
  _makeRouter() {
    const routes = [];
    const add = (method, path) => (p, handler) => {
      routes.push({ method, path, handler });
    };
    const router = {
      get: add('GET', null),
      post: add('POST', null),
      put: add('PUT', null),
      delete: add('DELETE', null),
      patch: add('PATCH', null),
      all: add('*', null),
      _routes: routes,
    };
    return router;
  }

  _matchFunctionRoute(method, pathname) {
    for (const r of this._fnRoutes) {
      if (r.method !== '*' && r.method !== method) continue;
      if (typeof r.path === 'string') {
        // ':param' segments match any non-slash segment
        if (r.path.includes(':')) {
          const pat = new RegExp('^' + r.path.split('/').map(s => s.startsWith(':') ? '([^/]+)' : s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('/') + '$');
          const m = pathname.match(pat);
          if (m) return { handler: r.handler, params: m };
          continue;
        }
        if (r.path !== pathname) continue;
        return { handler: r.handler, params: null };
      }
      const m = pathname.match(r.path);
      if (m) return { handler: r.handler, params: m };
    }
    return null;
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

    // ── v2 function-style mount routes (registered via gw.router) ──
    const fnMatch = this._matchFunctionRoute(req.method, pathname);
    if (fnMatch) {
      const bot = this._auth(req);
      if (!bot) { this._audit({ type: 'auth_rejected', path: pathname }); return send(res, 401, { error: 'unauthorized' }); }
      req.bot = bot; // fn-mount handlers call isOperator(req) on the raw req
      const { resolveTenant } = require('./tenant-resolve');
      const { tenant } = resolveTenant(req, this);
      return fnMatch.handler(req, res, { url, params: fnMatch.params, bot, tenantId: tenant?.id || null });
    }

    // ── v2 plugin mounts (before v1 auth; each mount declares its auth mode) ──
    for (const mount of this.mounts) {
      const params = match(mount, req.method, pathname);
      if (!params) continue;
      let bot = null;
      if (mount.auth === 'bearer') {
        bot = this._auth(req);
        if (!bot) { this._audit({ type: 'auth_rejected', path: pathname }); return send(res, 401, { error: 'unauthorized' }); }
        const rl = this._enforceRateLimit(bot);
        if (rl.status === 429) { this._audit({ type: 'rate_limited', bot: bot.name, path: pathname }); return send(res, 429, rl.body); }
      } else if (mount.auth === 'query') {
        const token = url.searchParams.get('token') || '';
        bot = this._auth({ headers: { authorization: token ? `Bearer ${token}` : '' } });
        if (!bot) { this._audit({ type: 'auth_rejected', path: pathname }); return send(res, 401, { error: 'unauthorized' }); }
        const rl = this._enforceRateLimit(bot);
        if (rl.status === 429) { this._audit({ type: 'rate_limited', bot: bot.name, path: pathname }); return send(res, 429, rl.body); }
      }
      const { resolveTenant } = require('./tenant-resolve');
      const { tenant } = resolveTenant(req, this);
      return mount.handle(this, req, res, { url, params, bot, tenantId: tenant?.id || null, tenant });
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

    // Rate-limit guard (slice: perimeter-guards) — legacy v1 surface.
    const rl = this._enforceRateLimit(bot);
    if (rl.status === 429) {
      this._audit({ type: 'rate_limited', bot: bot.name, path });
      return send(res, 429, rl.body);
    }

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
      const limit = parseLimit(url.searchParams.get('limit'));
      if (limit === null) return send(res, 400, { error: 'invalid_limit' });
      const page = this.chain.since(since, { limit });
      const body = { entries: page.entries, nextSince: page.nextSince, head: this.chain.head.hash, verified: this.chain.verify() };
      if (page.nextSince !== null) body.cursor = page.nextSince;
      return send(res, 200, body);
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
      const action_id = body.action_id || null;
      const approval = this.approvals.request({
        bot,
        tool,
        args,
        reason: verdict.reason,
        action_id,
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
    // TG → AIE execution-time revalidation (TH-12): fail-closed by default
    const failOpen = process.env.TG_AIE_FAIL_OPEN === 'true';
    try {
      const rv = aie_revalidate(body.action_id || 'tg-' + Date.now(), { bot: bot.name, tool, args });
      if (!rv.ok) {
        this._audit({ type: 'action.revalidation_failed', bot: bot.name, tool, error: rv.code });
        if (!failOpen) {
          // Map AIE codes → TG HTTP
          let status = 403, err = 'revalidation_failed';
          if (rv.code === 'AIE-AUTH-002') { status = 410; err = 'lease_expired'; }
          else if (rv.code === 'AIE-AUTH-003') { err = 'authority_revoked'; }
          else if (rv.code === 'AIE-AUTH-004') { err = 'action_not_admitted'; }
          else if (rv.code === 'AIE_UNREACHABLE') { status = 502; err = 'aie_unreachable'; }
          return send(res, status, { decision: 'deny', error: err, error_code: rv.code });
        }
      }
    } catch (e) {
      this._audit({ type: 'action.revalidation_failed', bot: bot.name, tool, error: String(e) });
      if (!failOpen) return send(res, 502, { decision: 'deny', error: 'aie_unreachable' });
    }
    if (this.budgets && !this.budgets.consume(bot.name).ok) {
      this._audit({ type: 'budget_denied', bot: bot.name, tool });
      return send(res, 402, { decision: 'deny', error: 'budget_exhausted' });
    }
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
    const parkedAction = parked && parked.status === 'pending'
      ? { tool: parked.tool, args: parked.args, bot: parked.bot, action_id: parked.action_id }
      : null;
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
    // Generate fallback action_id when AIE is not in use (most tests). The
    // aie_revalidate call below handles missing AIE via TG_AIE_FAIL_OPEN.
    const actionId = parkedAction.action_id || 'tg-apr-' + id;
    // TG → AIE execution-time revalidation (TH-12): fail-closed by default
    const failOpen = process.env.TG_AIE_FAIL_OPEN === 'true';
    try {
      const rv = aie_revalidate(actionId, { bot: parkedAction.bot, tool: parkedAction.tool, args: parkedAction.args });
      if (!rv.ok) {
        this._audit({ type: 'action.revalidation_failed', bot: parkedAction.bot, tool: parkedAction.tool, error: rv.code });
        if (!failOpen) {
          let status = 403, err = 'revalidation_failed';
          if (rv.code === 'AIE-AUTH-002') { status = 410; err = 'lease_expired'; }
          else if (rv.code === 'AIE-AUTH-003') { err = 'authority_revoked'; }
          else if (rv.code === 'AIE-AUTH-004') { err = 'action_not_admitted'; }
          else if (rv.code === 'AIE_UNREACHABLE') { status = 502; err = 'aie_unreachable'; }
          return send(res, status, { id, status: 'approved', decision: 'deny', error: err, error_code: rv.code });
        }
      }
    } catch (e) {
      this._audit({ type: 'action.revalidation_failed', bot: parkedAction.bot, tool: parkedAction.tool, error: String(e) });
      if (!failOpen) return send(res, 502, { id, status: 'approved', decision: 'deny', error: 'aie_unreachable' });
    }
    if (this.budgets && !this.budgets.consume(parkedAction.bot).ok) {
      this._audit({ type: 'budget_denied', bot: parkedAction.bot, tool: parkedAction.tool });
      return send(res, 402, { id, status: 'approved', decision: 'deny', error: 'budget_exhausted' });
    }
    try {
      const out2 = await this._run(parkedAction.bot, parkedAction.tool, parkedAction.args);
      this._audit({ type: 'action_executed_after_approval', approvalId: id, tool: parkedAction.tool, ok: true });
      return send(res, 200, { id, status: 'approved', result: out2 });
    } catch (e) {
      this._audit({ type: 'action_executed_after_approval', approvalId: id, tool: parkedAction.tool, ok: false });
      return send(res, 502, { id, status: 'approved', error: 'dispatch_failed' });
    }
  }
}

// sha256 hex digest of a bearer token — the only form persisted at rest.
function hashToken(token) {
  return crypto.createHash('sha256').update(token, 'utf8').digest('hex');
}

function cryptoSafeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

// Parses a `limit` query-string value. Returns null on invalid (fail closed),
// number otherwise. Default 500 when the param is missing.
function parseLimit(raw) {
  if (raw === null || raw === undefined || raw === '') return 500;
  const n = Number(raw);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < 1 || n > MAX_PAGE_LIMIT) return null;
  return n;
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

// Token rotation gate: operator can rotate any bot; non-operator can rotate only itself.
function canSelfRotate(caller, target) {
  if (!caller || !target) return false;
  if (caller.role === 'operator') return true;
  return caller.name === target;
}

module.exports = { Gateway, send, readBody, canApprove, canSelfRotate, parseLimit, hashToken };
