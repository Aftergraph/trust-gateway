'use strict';
// W7 CLI — subcommand handlers. Each handler receives a context:
//   { client, palette, out, json, flags, positionals }
// and resolves to an exit code (0 ok, 1 failure). Handlers never throw for
// server-side rejections (GatewayClient resolves 4xx/5xx as {error}); only
// transport errors bubble up, and index.js turns those into `✗ error: …`.
// With --json every handler prints exactly one JSON document to stdout.

const { shortHash, timeStr, table, payloadDigest, kv, truncate } = require('./format');

function write(out, lines) {
  out(lines.join('\n') + '\n');
}

// ── status ────────────────────────────────────────────────────────────────
async function status(ctx) {
  const { client, palette, out, json } = ctx;
  const health = await client.health();
  const verify = await client.verify();
  const pend = await client.pending();
  const pendingList = Array.isArray(pend.pending) ? pend.pending : null;
  let stats = null;
  try { stats = await client.stats(); } catch { /* non-fatal */ }

  const chainOk = !!(verify && verify.ok === true);
  const ok = !!(health && health.ok === true) && chainOk && pendingList !== null;

  if (json) {
    out(JSON.stringify({
      url: client.baseUrl,
      ok,
      health,
      chain: verify,
      pending: pendingList,
      pendingCount: pendingList ? pendingList.length : null,
      stats: stats && !stats.error ? stats : null,
    }, null, 2) + '\n');
    return ok ? 0 : 1;
  }

  const lines = [`${palette.cyan(palette.bold('● trust-gateway'))} ${palette.dim(client.baseUrl)}`];
  lines.push(kv(palette, 'health', health && health.ok
    ? `${palette.badge(true)} ok`
    : `${palette.badge(false)} unreachable`));
  if (chainOk) {
    lines.push(kv(palette, 'chain', `${palette.badge(true)} ${palette.ok('SEALED')} ${palette.dim(`· ${verify.length} entries · head ${shortHash(verify.head)} · chain ${shortHash(verify.chainId)}`)}`));
  } else if (verify && verify.error) {
    lines.push(kv(palette, 'chain', `${palette.badge(false)} ${palette.bad('unknown')} ${palette.dim(`(${verify.error})`)}`));
  } else {
    lines.push(kv(palette, 'chain', `${palette.badge(false)} ${palette.bad('TAMPERED')} ${palette.dim(`at seq ${verify.at} (${verify.reason})`)}`));
  }
  if (pendingList) {
    lines.push(kv(palette, 'pending', pendingList.length === 0
      ? `${palette.ok('✓')} none — queue is clear`
      : `${palette.yellow(String(pendingList.length))} waiting ${palette.dim('· tg pending')}`));
  }
  if (stats && !stats.error) {
    const perBot = Object.entries(stats.bots || {}).map(([n, b]) => `${n}:${b.actions}a/${b.approvals}p/${b.denies}d`);
    if (perBot.length) lines.push(kv(palette, 'activity', perBot.join('  ')));
    if (stats.lastTs) lines.push(kv(palette, 'last', `${timeStr(stats.lastTs)} UTC`));
  }
  write(out, lines);
  return ok ? 0 : 1;
}

// ── verify ────────────────────────────────────────────────────────────────
async function verify(ctx) {
  const { client, palette, out, json } = ctx;
  const v = await client.verify();
  if (json) { out(JSON.stringify(v, null, 2) + '\n'); return v.ok === true ? 0 : 1; }
  if (v.error) {
    write(out, [`${palette.badge(false)} ${palette.bad('verify failed')}: ${v.error}`]);
    return 1;
  }
  if (v.ok) {
    write(out, [`${palette.badge(true)} ${palette.ok('audit chain intact')} — ${v.length} entries · head ${shortHash(v.head)} · chain ${shortHash(v.chainId)}`]);
    return 0;
  }
  write(out, [`${palette.badge(false)} ${palette.bad('AUDIT CHAIN TAMPERED')} at seq ${v.at} (${v.reason})`]);
  return 1;
}

// ── audit ─────────────────────────────────────────────────────────────────
async function audit(ctx) {
  const { client, palette, out, json, flags, positionals } = ctx;
  const since = Number(flags.since ?? positionals[0] ?? 0) || 0;
  const a = await client.audit(since);
  if (a.error) {
    if (json) { out(JSON.stringify(a, null, 2) + '\n'); return 1; }
    write(out, [`${palette.badge(false)} ${palette.bad('audit failed')}: ${a.error}`]);
    return 1;
  }
  const entries = Array.isArray(a.entries) ? a.entries : [];
  if (json) { out(JSON.stringify({ entries, head: a.head, verified: a.verified }, null, 2) + '\n'); return 0; }

  let shown = entries;
  const limit = flags.all ? Infinity : (Number(flags.limit) || 25);
  let note = '';
  if (entries.length > limit) {
    shown = entries.slice(entries.length - limit);
    note = palette.dim(`(newest ${limit} of ${entries.length} since seq ${since} — --all for everything)`);
  }
  const rows = shown.map((e) => [
    String(e.seq),
    timeStr(e.ts),
    shortHash(e.hash),
    payloadDigest(e.payload),
  ]);
  const head = [`${palette.dim('seq')}`, `${palette.dim('ts (UTC)')}`, `${palette.dim('hash')}`, palette.dim('event')];
  const lines = table(head, rows);
  lines.unshift(`${palette.bold('audit')} ${palette.dim(`· ${entries.length} entries since seq ${since} · head ${shortHash(a.head)} · chain ${a.verified && a.verified.ok ? palette.ok('SEALED') : palette.bad('TAMPERED')}`)}`);
  if (note) lines.push(note);
  if (!rows.length) lines.push(palette.dim('  (no entries)'));
  write(out, lines);
  return 0;
}

// ── pending ───────────────────────────────────────────────────────────────
async function pending(ctx) {
  const { palette, out, json, client } = ctx;
  const r = await client.pending();
  if (r.error) {
    if (json) { out(JSON.stringify(r, null, 2) + '\n'); return 1; }
    write(out, [`${palette.badge(false)} ${palette.bad('pending failed')}: ${r.error}`]);
    return 1;
  }
  const list = Array.isArray(r.pending) ? r.pending : [];
  if (json) { out(JSON.stringify({ pending: list }, null, 2) + '\n'); return 0; }
  if (!list.length) {
    write(out, [`${palette.badge(true)} ${palette.ok('no pending approvals')} — the queue is clear`]);
    return 0;
  }
  const rows = list.map((p) => [
    p.id, p.bot, truncate(p.tool, 24),
    timeStr(p.expiresAt), truncate(p.reason || '', 34),
  ]);
  const lines = table([
    palette.dim('id'), palette.dim('bot'), palette.dim('tool'), palette.dim('expires (UTC)'), palette.dim('reason'),
  ], rows);
  lines.unshift(`${palette.yellow(String(list.length))} pending approval ${list.length === 1 ? 'request' : 'requests'} ${palette.dim('· tg approve <id> | tg deny <id>')}`);
  write(out, lines);
  return 0;
}

// ── approve / deny ────────────────────────────────────────────────────────
function decideVia(verb) { // 'approve' | 'deny'
  return async function decide(ctx) {
    const { client, palette, out, json, positionals } = ctx;
    const id = positionals[0];
    if (!id) {
      if (json) { out(JSON.stringify({ error: `${verb}_id_required` }, null, 2) + '\n'); return 1; }
      write(out, [`${palette.badge(false)} ${palette.bad(`usage: tg ${verb} <approval-id>`)}`]);
      return 1;
    }
    const r = verb === 'approve' ? await client.approve(id) : await client.deny(id);
    const wanted = verb === 'approve' ? 'approved' : 'denied';
    const ok = r.status === wanted;
    if (json) { out(JSON.stringify(r, null, 2) + '\n'); return ok ? 0 : 1; }
    if (r.error && !r.status) {
      write(out, [`${palette.badge(false)} ${palette.bad(`${verb} failed`)}: ${r.error} ${palette.dim(`(${id})`)}`]);
      return 1;
    }
    if (ok) {
      const done = verb === 'approve' ? 'approved' : 'denied';
      const lines = [`${palette.badge(true)} ${palette.ok(`${done} ${r.id || id}`)}`];
      if (r.result !== undefined) lines.push(`  ${palette.label('result')} ${truncate(JSON.stringify(r.result), 120)}`);
      if (r.error) lines.push(`  ${palette.yellow(`note: ${r.error}`)}`);
      write(out, lines);
      return r.error ? 1 : 0;
    }
    write(out, [`${palette.badge(false)} ${palette.bad(`${verb} not applied`)}: status=${r.status ?? '?'} ${r.error ? `error=${r.error}` : ''}`.trim()]);
    return 1;
  };
}

// ── chat ──────────────────────────────────────────────────────────────────
async function chat(ctx) {
  const { client, palette, out, json, flags, positionals } = ctx;
  const message = positionals.join(' ');
  if (!message) {
    if (json) { out(JSON.stringify({ error: 'message_required' }, null, 2) + '\n'); return 1; }
    write(out, [`${palette.badge(false)} ${palette.bad('usage: tg chat <message...>')} ${palette.dim('(-s <session> -b <bot>)')}`]);
    return 1;
  }
  const r = await client.chat(message, { session: flags.session || 'cli', bot: flags.bot });
  if (r.error || typeof r.reply !== 'string') {
    if (json) { out(JSON.stringify(r, null, 2) + '\n'); return 1; }
    write(out, [`${palette.badge(false)} ${palette.bad('chat failed')}: ${r.error || 'no reply'}`]);
    return 1;
  }
  if (json) { out(JSON.stringify(r, null, 2) + '\n'); return 0; }
  const lines = [`${palette.ok('reply')} ${palette.dim(`[${flags.session || 'cli'}]`)} ${r.reply.replace(/\n/g, '\n       ')}`];
  for (const a of r.actions || []) {
    const mark = a.decision === 'allow' && !a.error ? palette.badge(true)
      : a.decision === 'needs_approval' ? palette.yellow('⏸')
      : palette.badge(false);
    let l = `  ${mark} ${a.tool} → ${a.decision}`;
    if (a.approvalId) l += ` ${palette.dim(a.approvalId)}`;
    if (a.result) l += ` ${palette.dim(truncate(JSON.stringify(a.result), 60))}`;
    if (a.reason) l += ` ${palette.dim(`(${a.reason})`)}`;
    lines.push(l);
  }
  write(out, lines);
  return 0;
}

// ── search ────────────────────────────────────────────────────────────────
async function search(ctx) {
  const { client, palette, out, json, flags, positionals } = ctx;
  const q = positionals.join(' ');
  if (!q) {
    if (json) { out(JSON.stringify({ error: 'query_required' }, null, 2) + '\n'); return 1; }
    write(out, [`${palette.badge(false)} ${palette.bad('usage: tg search <query...>')} ${palette.dim('(-n <limit>)')}`]);
    return 1;
  }
  const r = await client.search(q, flags.limit);
  if (r.error && !Array.isArray(r.hits)) {
    if (json) { out(JSON.stringify(r, null, 2) + '\n'); return 1; }
    write(out, [`${palette.badge(false)} ${palette.bad('search failed')}: ${r.error}`]);
    return 1;
  }
  const hits = r.hits || [];
  if (json) { out(JSON.stringify({ query: q, total: hits.length, hits }, null, 2) + '\n'); return 0; }
  if (!hits.length) {
    write(out, [`${palette.dim(`no audit-chain hits for “${q}”`)}`]);
    return 0;
  }
  const rows = hits.map((h) => [String(h.seq), timeStr(h.ts), shortHash(h.hash), payloadDigest(h.payload)]);
  const lines = table([palette.dim('seq'), palette.dim('ts (UTC)'), palette.dim('hash'), palette.dim('match')], rows);
  lines.unshift(`${palette.bold('search')} ${palette.dim(`“${q}” · ${hits.length} hit${hits.length === 1 ? '' : 's'} (newest first)`)}`);
  write(out, lines);
  return 0;
}

module.exports = { status, verify, audit, pending, approve: decideVia('approve'), deny: decideVia('deny'), chat, search };
