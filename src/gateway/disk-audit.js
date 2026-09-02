'use strict';
// Trust Gateway — durable audit: append-only JSONL, one fsync per entry.
// Load semantics (fail closed):
//   - missing/empty file      → fresh chain, genesis written to disk
//   - trailing partial line   → crash artifact, dropped, file rewritten
//   - any broken/tampered line in history → REFUSE to load (throw)

const fs = require('node:fs');
const path = require('node:path');
const { HashChain } = require('./hash-chain');

function loadChain(file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const exists = fs.existsSync(file);
  if (!exists) {
    const c = new HashChain();
    fs.appendFileSync(file, JSON.stringify(c.entries[0]) + '\n');
    const fd = fs.openSync(file, 'r');
    try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    return { chain: c, droppedPartial: false };
  }
  const raw = fs.readFileSync(file, 'utf8');
  if (raw.trim() === '') {
    // empty file (e.g. touched) → treat as fresh genesis
    const c = new HashChain();
    fs.appendFileSync(file, JSON.stringify(c.entries[0]) + '\n');
    return { chain: c, droppedPartial: false };
  }
  const lines = raw.split('\n');
  const entries = [];
  let droppedPartial = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim() === '') continue;
    try {
      entries.push(JSON.parse(line));
    } catch {
      const isLastNonEmpty = lines.slice(i + 1).every((l) => l.trim() === '');
      if (isLastNonEmpty) { droppedPartial = true; break; } // crash mid-write
      throw new Error(
        `disk-audit: unparseable entry at line ${i + 1} (not trailing) — refusing to load (fail closed)`
      );
    }
  }
  if (droppedPartial) {
    fs.writeFileSync(file, entries.map((e) => JSON.stringify(e)).join('\n') + '\n');
    const fd = fs.openSync(file, 'r');
    try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  }
  const chain = HashChain.fromEntries(entries);
  return { chain, droppedPartial };
}

function openAppendFd(file) {
  return fs.openSync(file, 'a');
}

function appendTo(fd, entry) {
  fs.writeSync(fd, JSON.stringify(entry) + '\n');
  fs.fsyncSync(fd);
}

module.exports = { loadChain, openAppendFd, appendTo };