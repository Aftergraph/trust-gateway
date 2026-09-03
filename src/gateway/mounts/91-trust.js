'use strict';
// v2 wave D (D4) mount: injection tripwire endpoints.
//
//   POST /v2/trust/scan   {text}  → {chars, hits:[{rule, at}]}   (bearer)
//   GET  /v2/trust/report         → {scans:[{at, bot, chars, hits, rules}]}
//                                    the LAST 10 scans' metadata      (bearer)
//
// Audit hygiene (the whole point of this mount being separate): a `trust_scan`
// chain entry carries ONLY {bot, chars, hits, rules}. The scanned text is
// attacker-authored by definition — it must never enter the chain, the
// report, or a log line. Same stance as webtools.js ("host only, never the
// page text") and approvals.js (args scrubbed after resolve).
//
// The report ring is per-process in memory (restart resets it); the durable
// record is the audit chain, which — by design — holds only the metadata.
// One mount file serves both routes via method '*' + an exact RegExp path;
// the ABI (rule 2) allows one route object per file, so splitting a second
// file was the alternative — single file keeps the pair atomic.

const { send, readBody } = require('../server');
const { scanForInjection, INJECTION_RULES } = require('../trust');

const MAX_SCAN_CHARS = 32_000; // generous for pages, cheap vs the 256k body cap
const REPORT_KEEP = 10;

const rings = new WeakMap(); // gw -> [{at, bot, chars, hits, rules}] (max 10)
function ring(gw) {
  let r = rings.get(gw);
  if (!r) { r = []; rings.set(gw, r); }
  return r;
}

module.exports = {
  name: 'v2-trust',
  method: '*',
  path: /^\/v2\/trust\/(scan|report)$/,
  auth: 'bearer',
  MAX_SCAN_CHARS,
  REPORT_KEEP,
  handle: async (gw, req, res, ctx) => {
    const bot = ctx.bot; // auth:'bearer' — server already rejected otherwise

    // ── GET /v2/trust/report — metadata-only, last 10 ──
    if (ctx.url.pathname === '/v2/trust/report') {
      if (req.method !== 'GET') return send(res, 405, { error: 'method_not_allowed' });
      return send(res, 200, {
        keep: REPORT_KEEP,
        ruleSet: INJECTION_RULES.map((r) => r.rule),
        scans: ring(gw).slice(), // chronological, oldest first
      });
    }

    // ── POST /v2/trust/scan ──
    if (req.method !== 'POST') return send(res, 405, { error: 'method_not_allowed' });
    let body;
    try {
      body = JSON.parse((await readBody(req)) || '{}');
    } catch (e) {
      if (e && String(e.message) === 'body_too_large') return send(res, 413, { error: 'body_too_large' });
      return send(res, 400, { error: 'invalid_json' });
    }
    const text = body && body.text;
    if (typeof text !== 'string') return send(res, 400, { error: 'text_required' });
    if (text.length > MAX_SCAN_CHARS) return send(res, 400, { error: 'text_too_long' });

    const hits = scanForInjection(text);
    const rules = [...new Set(hits.map((h) => h.rule))];
    // Write-ahead audit: metadata ONLY. Never `text`, never any hit snippet.
    gw._audit({ type: 'trust_scan', bot: bot.name, chars: text.length, hits: hits.length, rules });
    const r = ring(gw);
    r.push({ at: gw.now(), bot: bot.name, chars: text.length, hits: hits.length, rules });
    while (r.length > REPORT_KEEP) r.shift();
    return send(res, 200, { chars: text.length, hits });
  },
};
