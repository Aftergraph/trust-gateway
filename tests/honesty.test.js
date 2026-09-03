'use strict';
// FS-E4 transparency honesty tests — source-level: the public site and the
// standards docs must not make absolute claims the codebase cannot back
// (roadmap §v2i-4). Absolute strings were replaced with roadmap-qualified
// ones; true claims (hash-chain, fail-closed, write-only secrets, fallback
// chains) stay.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = process.cwd();
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

test('pricing.html: no unqualified tenant-isolation claim; roadmap qualifier present', () => {
  const html = read('site/pricing.html');
  assert.ok(!/tenant-isolated/i.test(html),
    'old absolute "tenant-isolated" claim must be gone');
  assert.match(html, /single-tenant today/i, 'single-tenant reality stated');
  assert.match(html, /multi-tenant foundation on roadmap v3/i,
    'roadmap qualifier present');
  assert.ok(!/jailed computer per bot/i.test(html),
    '"jailed computer per bot" downgraded to jail reality');
  assert.match(html, /jailed process island per bot/i, 'jail claim grounded');
});

test('index.html: comparison table carries roadmap qualifiers + audit stamp', () => {
  const html = read('site/index.html');
  assert.ok(!/tenant-isolated/i.test(html),
    'unqualified "Hosted, tenant-isolated" removed');
  assert.match(html, /Hosted \(single-tenant today; multi-tenant foundation on roadmap v3\)/,
    'hosting claim qualified');
  assert.match(html, /Jailed process island per bot \(OS-level sandbox on roadmap\)/,
    'computer claim downgraded with sandbox nuance');
  assert.match(html, /Claims audited against the codebase 2026-09-03/,
    'audit stamp under the comparison table');
});

test('COMPARISON doc: audited stamp present, unqualified claims gone', () => {
  const md = read('docs/COMPARISON-2026-09-02.md');
  assert.match(md, /Claims audited against the codebase 2026-09-03/,
    'audit stamp under the feature matrix');
  assert.ok(!/tenant-isoleret/i.test(md), 'unqualified "tenant-isoleret" removed');
  assert.match(md, /single-tenant i dag/i, 'single-tenant reality stated');
});

test('AI-GOVERNANCE.md: Known limitations section exists and is audited', () => {
  const md = read('docs/standards/AI-GOVERNANCE.md');
  assert.match(md, /Known limitations \(audited 2026-09-03\)/,
    'Known limitations section present');
  assert.match(md, /process discipline, not an OS sandbox/i,
    'jail limitation stated');
  assert.match(md, /in-process \(in-memory\)/i, 'rate-limit limitation stated');
  assert.match(md, /[Bb]ackups are manual/i, 'backup limitation stated');
  assert.match(md, /[Ss]ingle-tenant\./, 'single-tenant limitation stated');
});

test('status.html: roadmap pointer line present', () => {
  const html = read('site/status.html');
  assert.match(html, /Roadmap: <code>docs\/ROADMAP\.md<\/code>/,
    'muted roadmap line present');
});

test('true claims stay: hash-chain, fail-closed, write-only secrets, fallback', () => {
  const pricing = read('site/pricing.html');
  assert.match(pricing, /hash-chained audit trail/i, 'sealed chain claim kept');
  assert.match(pricing, /fail-closed policy engine/i, 'fail-closed claim kept');
  const governance = read('docs/standards/AI-GOVERNANCE.md');
  assert.match(governance, /write-only secret/i, 'secret hygiene claim kept');
  assert.match(governance, /fallback/i, 'fallback claim kept');
});
