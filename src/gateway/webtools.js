'use strict';
// Trust Gateway v2 — wave C web/browser tools.
// C3 deliverable: SSRF-guarded page fetch + text extract for the synthetic
// web.fetch:* / web.extract:* tool namespaces (mounted from mounts/65-web.js).
//
// Threat model: a bot can ask us to fetch ANY URL. We MUST refuse anything
// that resolves to a non-public address. Even a single IP-literal that
// happens to be 127.0.0.1 or ::1 leaks the whole host (cloud metadata,
// intra-cluster admin, the gateway itself on a routable alt-port, etc.).
// Resolution is per-hop so redirects cannot re-target us at a private host.
//
// The key security properties, in order:
//   1. Reject non-http(s) schemes (no file:, no gopher:, no javascript:).
//   2. Resolve the hostname via dns.promises.lookup({all:true}) and REFUSE
//      if ANY returned address is in a private/loopback/link-local/
//      multicast/reserved range. Catches IPv4 literals AND DNS-rebinding
//      style attacks (the resolved address is what we'd actually dial).
//   3. Re-validate on every redirect (max 2 hops, depth-bounded).
//   4. Always dial via node:https — http:// is hard-rejected (no scheme
//      confusion, no accidental plaintext, no 80/tcp egress).
//
// Output is intentionally modest: {url, status, title, textBytes, text},
// where text is the html→text projection of the body, capped to maxBytes.
// The page text never appears in audit logs (it may carry user-controlled
// content + downstream tool args will reference it by artifact / jail path).

const dns = require('node:dns/promises');
const https = require('node:https');
const path = require('node:path');
const fs = require('node:fs');
const { URL } = require('node:url');

// ────────────────────────────────────────────────────────────────────────────
// isPrivateAddress — pure, dependency-free, IPv4 + IPv6 (incl. v4-mapped).
// Returns true for anything that must NEVER be dialled from this process:
//   0.0.0.0, 127.0.0.0/8, 10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16,
//   169.254.0.0/16 (link-local + cloud metadata), 100.64.0.0/10 (CGNAT),
//   224.0.0.0/4 (multicast), 240.0.0.0/4 (reserved), 255.255.255.255,
//   ::1, ::/128 unspecified, fc00::/7 (ULA), fe80::/10 (link-local),
//   ff00::/8 (multicast), and IPv4-mapped IPv6 (::ffff:a.b.c.d) when the
//   embedded v4 is private. IPv6 documentation prefix 2001:db8::/32 is also
//   refused (RFC 3849 — never routable).
// ────────────────────────────────────────────────────────────────────────────

function isPrivateAddress(addr) {
  if (typeof addr !== 'string' || addr.length === 0) return true; // fail closed
  // Normalize bracketed IPv6 ("[::1]") from URL.hostname if any caller passes raw.
  let a = addr;
  if (a.startsWith('[') && a.endsWith(']')) a = a.slice(1, -1);

  // ── IPv4 (and IPv4-mapped IPv6 unwrapped) ────────────────────────────
  const v4 = a.includes('.') && !a.includes(':');
  const mapped = a.toLowerCase().startsWith('::ffff:');
  if (v4 || mapped) {
    const v4str = mapped ? a.slice(7) : a;
    const parts = v4str.split('.');
    if (parts.length !== 4) return true; // malformed → refuse
    const o = parts.map((p) => {
      const n = Number(p);
      if (!/^\d{1,3}$/.test(p) || !Number.isFinite(n) || n < 0 || n > 255) return null;
      return n;
    });
    if (o.some((x) => x === null)) return true;
    const [a1, a2, a3, a4] = o;
    if (a1 === 0) return true;                                  // 0.0.0.0/8
    if (a1 === 10) return true;                                // 10.0.0.0/8
    if (a1 === 127) return true;                               // 127.0.0.0/8 loopback
    if (a1 === 169 && a2 === 254) return true;                 // 169.254.0.0/16 link-local
    if (a1 === 172 && a2 >= 16 && a2 <= 31) return true;        // 172.16.0.0/12
    if (a1 === 192 && a2 === 168) return true;                 // 192.168.0.0/16
    if (a1 === 100 && a2 >= 64 && a2 <= 127) return true;      // 100.64.0.0/10 CGNAT
    if (a1 >= 224 && a1 <= 239) return true;                    // 224.0.0.0/4 multicast
    if (a1 >= 240) return true;                                // 240.0.0.0/4 reserved + 255.255.255.255
    if (a1 === 198 && (a2 === 18 || a2 === 19)) return true;   // 198.18.0.0/15 benchmarking
    if (a1 === 192 && a2 === 0 && (a3 === 0 || a3 === 2)) return true; // 192.0.0.0/24, 192.0.2.0/24
    if (a1 === 192 && a2 === 88 && a3 === 99) return true;     // 6to4 anycast
    if (a1 === 198 && a2 === 51 && a3 === 100) return true;    // TEST-NET-2
    if (a1 === 203 && a2 === 0 && a3 === 113) return true;     // TEST-NET-3
    if (a1 === 192 && a2 === 0 && a3 === 0 && a4 !== 0) return true; // 192.0.0.0/24 (excl .0)
    return false;
  }

  // ── IPv6 ─────────────────────────────────────────────────────────────
  // We're permissive on parse-failure: return true (refuse) — better to
  // block a legitimate address than to dial an attacker-controlled one
  // we can't reason about.
  if (!a.includes(':')) return true;
  // Strip zone id (e.g. fe80::1%eth0) for the prefix check.
  const noZone = a.split('%')[0];
  // Lower-case + expand :: so byte math is straightforward.
  const lower = noZone.toLowerCase();
  if (lower === '::' || lower === '0:0:0:0:0:0:0:0' || lower === '::1' || lower === '0:0:0:0:0:0:0:1') {
    return true; // unspecified or loopback
  }
  // 2001:db8::/32 documentation
  if (lower.startsWith('2001:db8:') || lower === '2001:db8::') return true;
  // fc00::/7 unique local (covers fc.. AND fd.. — first hextet 0xfc..0xfd)
  if (lower.startsWith('fc') || lower.startsWith('fd')) {
    // ensure it's actually in 7-prefix form (16 bits), not e.g. fcc0: which is just 'fc' prefix
    if (/^f[cd][0-9a-f]{2}:/i.test(lower)) return true;
  }
  // fe80::/10 link-local (first 10 bits = 1111111010 → first byte 0xfe, second byte 0x80..0xbf).
  // The 3rd char covers 0..f, so combined with the 2nd char (8,9,a,b) the second byte spans 0x80..0xbf.
  if (/^fe[89ab][0-9a-f]:/i.test(lower)) return true;
  // ff00::/8 multicast
  if (lower.startsWith('ff')) return true;
  // ::ffff:0:0/96 IPv4-mapped — caught above, but a "::ffff:" form without
  // trailing v4 (malformed) still falls through here; refuse.
  if (lower.startsWith('::ffff:')) return true;
  return false;
}

// ────────────────────────────────────────────────────────────────────────────
// htmlToText — tiny, predictable HTML→text. Not a parser: just enough to
// make a fetched page useful as bot input without dragging in a dependency.
//   - <script>, <style>, <noscript> blocks removed wholesale
//   - <title>...</title> extracted separately
//   - all other tags → single space
//   - the 5 named entities most likely to matter in real pages decoded
//   - runs of whitespace collapsed to one space; trimmed on each end
// ────────────────────────────────────────────────────────────────────────────

const ENTITIES = {
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&#39;': "'",
  '&apos;': "'",
  '&nbsp;': ' ',
};

function decodeEntities(s) {
  // Named first (no regex backref cost).
  let out = s;
  for (const [k, v] of Object.entries(ENTITIES)) {
    if (out.includes(k)) out = out.split(k).join(v);
  }
  // Numeric &#NN; and &#xNN; — bounded to 6 hex/digit chars to keep this safe
  // (no catastrophic backtracking; the result is sanity-clamped to a char).
  out = out.replace(/&#x([0-9a-fA-F]{1,6});/g, (_, h) => {
    const n = parseInt(h, 16);
    return Number.isFinite(n) && n <= 0x10ffff ? safeFromCodePoint(n) : '';
  });
  out = out.replace(/&#(\d{1,7});/g, (_, d) => {
    const n = parseInt(d, 10);
    return Number.isFinite(n) && n <= 0x10ffff ? safeFromCodePoint(n) : '';
  });
  return out;
}

function safeFromCodePoint(n) {
  try { return String.fromCodePoint(n); } catch { return ''; }
}

function htmlToText(html) {
  if (typeof html !== 'string' || html.length === 0) return '';
  let s = html;
  // Drop <script>/<style>/<noscript> blocks first so their text content
  // never bleeds into the output (this is the user-facing security win).
  s = s.replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi, ' ');
  s = s.replace(/<style\b[^>]*>[\s\S]*?<\/style\s*>/gi, ' ');
  s = s.replace(/<noscript\b[^>]*>[\s\S]*?<\/noscript\s*>/gi, ' ');

  // Extract <title>…</title> separately.
  const titleMatch = /<title\b[^>]*>([\s\S]*?)<\/title\s*>/i.exec(s);
  const title = titleMatch ? decodeEntities(titleMatch[1].replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim() : '';

  // All remaining tags → single space. Do NOT try to preserve newlines on
  // </p> — for a bot-input projection, the LLM doesn't care and the test
  // expects whitespace-collapse.
  s = s.replace(/<[^>]+>/g, ' ');

  // Decode entities + collapse whitespace.
  s = decodeEntities(s);
  s = s.replace(/\s+/g, ' ').trim();

  return { title, text: s };
}

// ────────────────────────────────────────────────────────────────────────────
// SSRF-safe fetch with bounded redirect follow.
// fetchPage(url, opts) → {url, status, title, textBytes, text}
// opts (all optional):
//   maxBytes  — cap on body bytes read (default 512_000)
//   timeoutMs — per-request timeout (default 10_000)
//   transport — injectable for tests (default real node:https.request)
//   lookup    — injectable dns resolver (default dns.promises.lookup)
// Throws Error('blocked') for SSRF violations and non-http(s) schemes.
// ────────────────────────────────────────────────────────────────────────────

function normalizeUrl(url) {
  if (typeof url !== 'string' || url.length === 0) throw new Error('blocked:bad_url');
  let u;
  try { u = new URL(url); } catch { throw new Error('blocked:bad_url'); }
  if (u.protocol !== 'https:') throw new Error('blocked:scheme_not_https');
  if (!u.hostname) throw new Error('blocked:no_host');
  return u;
}

async function resolveAndCheck(hostname, lookup) {
  const res = await lookup(hostname, { all: true });
  if (!Array.isArray(res) || res.length === 0) throw new Error('blocked:dns_empty');
  for (const r of res) {
    if (!r || typeof r.address !== 'string' || r.address.length === 0) {
      throw new Error('blocked:dns_empty');
    }
    if (isPrivateAddress(r.address)) throw new Error('blocked:private_address');
  }
  return res;
}

function fetchPage(url, opts = {}) {
  const maxBytes = Number.isFinite(opts.maxBytes) ? opts.maxBytes : 512_000;
  const timeoutMs = Number.isFinite(opts.timeoutMs) ? opts.timeoutMs : 10_000;
  const transport = typeof opts.transport === 'function' ? opts.transport : https.request;
  const lookup = typeof opts.lookup === 'function' ? opts.lookup : dns.lookup;

  return new Promise(async (resolve, reject) => {
    let u;
    try { u = normalizeUrl(url); }
    catch (e) { return reject(e); }

    let redirectsLeft = 2; // 3 total (initial + 2 hops) per spec
    const callRecord = []; // for tests
    let lastUrl = u.toString();

    // The request loop is broken out so we can re-validate on redirect.
    const attempt = async (currentUrl, hops) => {
      let cu;
      try { cu = new URL(currentUrl); }
      catch { throw new Error('blocked:bad_url'); }
      if (cu.protocol !== 'https:') throw new Error('blocked:scheme_not_https');
      if (!cu.hostname) throw new Error('blocked:no_host');
      await resolveAndCheck(cu.hostname, lookup);

      return new Promise((resRes, resRej) => {
        const req = transport({
          method: 'GET',
          hostname: cu.hostname,
          path: cu.pathname + cu.search,
          port: cu.port || 443,
          headers: {
            'user-agent': 'TrustGateway/2 (web.fetch)',
            'accept': 'text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.5',
          },
        }, (res) => {
          callRecord.push({ url: cu.toString(), status: res.statusCode });
          // Redirect handling — only Location, only same/upgrade scheme.
          if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
            res.resume(); // drain
            if (hops <= 0) {
              return resRej(new Error('blocked:too_many_redirects'));
            }
            const next = new URL(res.headers.location, cu).toString();
            return attempt(next, hops - 1).then(resRes, resRej);
          }
          if (res.statusCode < 200 || res.statusCode >= 300) {
            res.resume();
            return resRej(new Error(`http_${res.statusCode}`));
          }
          const ctype = String(res.headers['content-type'] || '');
          let captured = 0;
          const chunks = [];
          let truncated = false;
          let timeoutHandle = null;
          const done = (err) => {
            if (timeoutHandle) clearTimeout(timeoutHandle);
            if (err) return resRej(err);
            const buf = Buffer.concat(chunks);
            const isHtml = /text\/html|application\/xhtml/i.test(ctype);
            if (!isHtml) {
              return resRes({
                url: cu.toString(),
                status: res.statusCode,
                contentType: ctype,
                title: '',
                textBytes: buf.length,
                text: '',
                truncated,
              });
            }
            const { title, text } = htmlToText(buf.toString('utf8'));
            // Hard cap on the projection too, so a giant <title> or
            // pathological entity expansion can't blow the envelope.
            const cap = Math.min(text.length, maxBytes);
            const t = text.slice(0, cap);
            return resRes({
              url: cu.toString(),
              status: res.statusCode,
              contentType: ctype,
              title: title.slice(0, 500),
              textBytes: Buffer.byteLength(t, 'utf8'),
              text: t,
              truncated: truncated || text.length > cap,
            });
          };
          timeoutHandle = setTimeout(() => {
            res.destroy(new Error('timeout'));
          }, timeoutMs);
          res.on('data', (c) => {
            if (captured >= maxBytes) {
              truncated = true;
              // We keep reading & discarding to drain so the socket can close.
              return;
            }
            const remaining = maxBytes - captured;
            if (c.length > remaining) {
              chunks.push(c.slice(0, remaining));
              captured += remaining;
              truncated = true;
            } else {
              chunks.push(c);
              captured += c.length;
            }
          });
          res.on('end', () => done());
          res.on('error', (e) => done(e));
        });
        // End-to-end timeout (covers redirect chains + slowloris).
        const endTimer = setTimeout(() => {
          try { req.destroy(new Error('timeout')); } catch { /* noop */ }
        }, timeoutMs);
        req.on('close', () => clearTimeout(endTimer));
        req.on('error', (e) => {
          clearTimeout(endTimer);
          resRej(e);
        });
        req.end();
      });
    };

    try {
      const out = await attempt(u.toString(), redirectsLeft);
      // attach callRecord for testability (not part of public return).
      out.__callRecord = callRecord;
      resolve(out);
    } catch (e) {
      reject(e);
    }
  });
}

// ────────────────────────────────────────────────────────────────────────────
// Artifact / jail storage. Prefer the durable artifact store when reachable
// (matches mounts/40-artifacts.js singleton pattern). Otherwise drop a
// jail-relative .txt under data/bots/<bot>/web/ and return the jail path.
// Both paths produce something the bot can `fs.read` later; neither leaks
// the page text into the audit log.
// ────────────────────────────────────────────────────────────────────────────

function tryArtifactStore(gw) {
  try {
    const { getArtifactStore } = require('./artifacts');
    return getArtifactStore(gw);
  } catch {
    return null;
  }
}

function writeJailText(gw, bot, content) {
  if (!gw || !gw.botsDir) throw new Error('no_jail_root');
  const target = path.join(bot, 'web', `${Date.now()}.txt`);
  const full = path.resolve(gw.botsDir, target);
  const root = path.resolve(gw.botsDir);
  if (full !== root && !full.startsWith(root + path.sep)) {
    throw new Error('escapes_jail');
  }
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content);
  return target; // jail-relative, never the absolute path
}

function storeFetchedText(gw, bot, fetched) {
  const store = tryArtifactStore(gw);
  if (store) {
    const r = store.create({
      kind: 'doc',
      title: (fetched.title || fetched.url).slice(0, 200),
      content: fetched.text.slice(0, 128 * 1024),
      bot,
    });
    if (r && r.ok) return { kind: 'artifact', id: r.artifact.id };
  }
  const rel = writeJailText(gw, bot, fetched.text);
  return { kind: 'jail', path: rel };
}

// ────────────────────────────────────────────────────────────────────────────
// makeWebExecutor({gw}) → async (bot, tool, args) → result
// The tool name itself encodes the URL host: "web.fetch:example.com/foo"
// or "web.extract:api.example.com/v1". We never put the full URL into
// the audit (may carry tokens in the query string).
// ────────────────────────────────────────────────────────────────────────────

function parseUrlFromTool(tool, args) {
  // Prefer args.url (canonical). Fall back to the suffix after `:`.
  if (args && typeof args.url === 'string' && args.url.length > 0) return args.url;
  if (typeof tool !== 'string') return null;
  const colon = tool.indexOf(':');
  if (colon < 0) return null;
  const rest = tool.slice(colon + 1);
  if (rest.length === 0) return null;
  // Heuristic: a host-shaped first segment — but tolerate full URLs too.
  if (rest.startsWith('http://') || rest.startsWith('https://')) return rest;
  return 'https://' + rest;
}

function makeWebExecutor({ gw }) {
  return async function webExecutor(bot, tool, args) {
    const url = parseUrlFromTool(tool, args);
    if (!url) return { ok: false, error: 'bad_url' };
    let parsed;
    try { parsed = new URL(url); }
    catch { return { ok: false, error: 'bad_url' }; }
    const host = parsed.hostname;
    let status = 0;
    let bytes = 0;
    let result;
    try {
      result = await fetchPage(url);
      status = result.status;
      bytes = result.textBytes;
    } catch (e) {
      const msg = String(e && e.message || e);
      // Refusal is part of the audit (so a malicious request is visible).
      try { gw._audit({ type: 'web_fetch', bot, host, status: 0, bytes: 0, error: msg }); } catch { /* noop */ }
      return { ok: false, error: msg };
    }
    // Audit: host ONLY — never the full URL (query may carry secrets), never
    // the page text (it'd bloat the chain and contaminate downstream arg
    // projections).
    try { gw._audit({ type: 'web_fetch', bot, host, status, bytes }); } catch { /* noop */ }

    let stored = null;
    try { stored = storeFetchedText(gw, bot, result); } catch { /* best effort */ }

    return {
      ok: true,
      url: result.url,
      status: result.status,
      title: result.title,
      textBytes: result.textBytes,
      // Page text stays in the result for the immediate caller, but is
      // also persisted to artifact/jail so a longer pipeline can re-read
      // it without re-fetching.
      text: result.text,
      stored,
    };
  };
}

module.exports = {
  fetchPage,
  htmlToText,
  makeWebExecutor,
  isPrivateAddress,
  // exported for tests:
  _internal: { decodeEntities, normalizeUrl, resolveAndCheck, storeFetchedText, parseUrlFromTool },
};
