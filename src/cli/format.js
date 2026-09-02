'use strict';
// W7 CLI/TUI — ANSI formatting helpers. Colors are opt-in per palette:
// enabled on a TTY (unless NO_COLOR), forced with --color / FORCE_COLOR,
// and disabled for piped output so tests see clean text. Symbols (✓ ✗ ● →)
// are always kept — they are plain Unicode, not control codes.

function makePalette(enabled = false) {
  const wrap = (open, close) => (s) =>
    enabled ? `\x1b[${open}m${String(s)}\x1b[${close}m` : String(s);
  return {
    enabled,
    bold: wrap('1', '22'),
    dim: wrap('2', '22'),
    red: wrap('31', '39'),
    green: wrap('32', '39'),
    yellow: wrap('33', '39'),
    cyan: wrap('36', '39'),
    /** green ✓ when ok, red ✗ when not */
    badge: (ok) => (ok ? wrap('1;32', '22')('✓') : wrap('1;31', '22')('✗')),
    ok: wrap('1;32', '22'),
    bad: wrap('1;31', '22'),
    label: wrap('36', '39'),
  };
}

function shortHash(h) {
  return h ? `${String(h).slice(0, 10)}…` : '—';
}

/** 'MM-DD HH:MM:SS' (UTC, deterministic for tests). */
function timeStr(ts) {
  if (!ts) return '—';
  const iso = new Date(ts).toISOString();
  return `${iso.slice(5, 10)} ${iso.slice(11, 19)}`;
}

function pad(s, n) {
  s = String(s);
  return s.length >= n ? s : s + ' '.repeat(n - s.length);
}

function truncate(s, n) {
  s = String(s).replace(/\s+/g, ' ');
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

/**
 * Fixed-width text table. rows: array of string-arrays. headers optional.
 * Returns an array of lines (no trailing newline).
 */
function table(headers, rows) {
  const all = headers ? [headers, ...rows] : rows;
  const widths = [];
  for (const r of all) {
    for (let c = 0; c < r.length; c++) {
      widths[c] = Math.max(widths[c] || 0, String(r[c] ?? '').length);
    }
  }
  const line = (r) => r.map((c, i) => pad(c ?? '', widths[i]).trimEnd()).join('  ').trimEnd();
  const out = all.map(line);
  if (headers && out.length) out.splice(1, 0, widths.map((w) => '─'.repeat(w)).join('  '));
  return out;
}

/** One-line digest of an audit payload for human tables (never leaks args). */
function payloadDigest(p) {
  if (!p || typeof p !== 'object') return '';
  const bits = [p.type || '?'];
  if (p.bot) bits.push(`bot=${p.bot}`);
  if (p.tool) bits.push(truncate(p.tool, 28));
  if (p.approvalId) bits.push(p.approvalId);
  else if (p.id && typeof p.id === 'string' && p.id.startsWith('apr_')) bits.push(p.id);
  if (p.decision) bits.push(`→${p.decision}`);
  if (p.error) bits.push(`error=${p.error}`);
  if (p.ok === false) bits.push('failed');
  return bits.join(' ');
}

/** Pretty key/value line aligned under a label column. */
function kv(palette, label, value) {
  return `  ${palette.label(pad(label, 9))} ${value}`;
}

module.exports = { makePalette, shortHash, timeStr, pad, truncate, table, payloadDigest, kv };
