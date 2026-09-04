'use strict';
// tests/standards.test.js — docs↔code sync gate.
//
// Asserts that the audit-event table in docs/standards/TRANSPARENCY.md
// contains every type string that appears as `{type: '…'}` anywhere under
// src/gateway/** (extracted programmatically, including the
// `enabled ? 'a' : 'b'` ternary pattern in plugins.js), and that the table
// invents nothing the code does not emit.
//
// Documented exceptions (see "Documented exceptions" in TRANSPARENCY.md):
//   - genesis / auth_rejected are already listed in the table; no skips.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const REPO = path.resolve(__dirname, '..');
const GATEWAY_DIR = path.join(REPO, 'src', 'gateway');
const DOC = path.join(REPO, 'docs', 'standards', 'TRANSPARENCY.md');

// Matches: type: 'foo'  |  type: enabled ? 'foo' : 'bar'
const TYPE_RE = /type:\s*(?:enabled\s*\?\s*)?'([a-z_]+)'(?:\s*:\s*'([a-z_]+)')?/g;
// Matches: audit('foo', …) — function-style mount emission (v2 waves K-Z)
const AUDIT_RE = /\baudit\(\s*'([a-z_]+)'/g;

function walk(dir) {
  const out = [];
  for (const f of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, f.name);
    if (f.isDirectory()) out.push(...walk(p));
    else if (f.name.endsWith('.js')) out.push(p);
  }
  return out;
}

function extractTypesFromCode() {
  const found = new Map(); // type -> Set(relative file)
  for (const file of walk(GATEWAY_DIR)) {
    const src = fs.readFileSync(file, 'utf8');
    let m;
    TYPE_RE.lastIndex = 0;
    while ((m = TYPE_RE.exec(src))) {
      for (const g of [m[1], m[2]]) {
        if (!g) continue;
        if (!found.has(g)) found.set(g, new Set());
        found.get(g).add(path.relative(REPO, file));
      }
    }
    AUDIT_RE.lastIndex = 0;
    while ((m = AUDIT_RE.exec(src))) {
      const g = m[1];
      if (!g) continue;
      if (!found.has(g)) found.set(g, new Set());
      found.get(g).add(path.relative(REPO, file));
    }
  }
  return found;
}

function extractTypesFromDoc() {
  const md = fs.readFileSync(DOC, 'utf8');
  const rows = {};
  // Table rows look like: | 1 | `action_decision` | server.js, groups.js |
  const rowRe = /^\|\s*\d+\s*\|\s*`([a-z_]+)`\s*\|/gm;
  let m;
  while ((m = rowRe.exec(md))) rows[m[1]] = true;
  return rows;
}

test('standards: TRANSPARENCY.md lists every audit type emitted in src/gateway/**', () => {
  const code = extractTypesFromCode();
  assert.ok(code.size >= 40, `expected a healthy event set, got ${code.size}`);
  const doc = extractTypesFromDoc();

  const missing = [...code.keys()].filter((t) => !doc[t]);
  assert.deepStrictEqual(
    missing,
    [],
    `TRANSPARENCY.md audit-event table is missing types found in code: ${missing.join(', ')}` +
      '\n→ add them to the table in docs/standards/TRANSPARENCY.md (same commit).'
  );
});

test('standards: TRANSPARENCY.md invents no event type the code does not emit', () => {
  const code = extractTypesFromCode();
  const doc = extractTypesFromDoc();

  const invented = Object.keys(doc).filter((t) => !code.has(t));
  assert.deepStrictEqual(
    invented,
    [],
    `TRANSPARENCY.md lists types not found as {type: '…'} in src/gateway/**: ${invented.join(', ')}` +
      '\n→ remove them, or fix the emitter if the code was renamed.'
  );
});

test('standards: documented exceptions (genesis, auth_rejected) are actually listed', () => {
  const doc = extractTypesFromDoc();
  for (const t of ['genesis', 'auth_rejected']) {
    assert.ok(doc[t], `documented exception '${t}' must appear in the table`);
  }
  const md = fs.readFileSync(DOC, 'utf8');
  assert.ok(/Documented exceptions/.test(md), 'exceptions section must exist');
});

test('standards: doc table count matches extraction exactly', () => {
  const code = extractTypesFromCode();
  const doc = extractTypesFromDoc();
  assert.strictEqual(
    Object.keys(doc).length,
    code.size,
    'table row count must equal the number of distinct {type: …} strings in src/gateway/**'
  );
});

test('standards: governance + agent docs exist and cross-reference the event table', () => {
  const gov = fs.readFileSync(path.join(REPO, 'docs', 'standards', 'AI-GOVERNANCE.md'), 'utf8');
  assert.ok(/fail-closed/i.test(gov), 'AI-GOVERNANCE.md must state the fail-closed policy');
  assert.ok(/tamper/i.test(gov), 'AI-GOVERNANCE.md must cover tamper-evidence');
  assert.ok(/free/i.test(gov), 'AI-GOVERNANCE.md must be honest about free-tier lanes');
  assert.ok(/SEALED/.test(gov) && /TAMPERED/.test(gov), 'AI-GOVERNANCE.md must define SEALED and TAMPERED operationally');

  const agents = fs.readFileSync(path.join(REPO, 'docs', 'standards', 'CODING-AGENTS.md'), 'utf8');
  assert.ok(/zero dependen/i.test(agents), 'agent doc must state the zero-dep rule');
  assert.ok(/server\.js/.test(agents) && /mount/i.test(agents), 'agent doc must state the mounts-only rule');
  assert.ok(/textContent/.test(agents), 'agent doc must state the textContent-only rule');
  assert.ok(/audit/i.test(agents), 'agent doc must state the audit rule');
  assert.ok(/node --test/.test(agents), 'agent doc must state the test-before-commit rule');
});