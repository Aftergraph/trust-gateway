'use strict';
// FS-W5 — deep healthz aggregator.
// Per-subsystem health check. Always returns 200 unless a critical
// subsystem reports unhealthy. Read-only, no side effects.
//
// Subsystems checked:
//   - chain: audit_chain head exists and reachable
//   - db: shared connection responsive
//   - disk: filesystem free space
//   - gateway: process.uptime + mem usage

const { db } = require('./db');
const fs = require('node:fs');

function _safe(fn) {
  try { return fn(); } catch (e) { return { ok: false, error: String(e.message || e) }; }
}

function check() {
  const out = { ts: Date.now(), checks: {} };

  out.checks.chain = _safe(() => {
    let head;
    try {
      head = db.prepare(`SELECT seq, hash FROM audit_chain ORDER BY seq DESC LIMIT 1`).get();
    } catch (e) {
      return { ok: false, error: 'no_audit_chain', message: String(e.message || e) };
    }
    return { ok: !!head, headSeq: head?.seq, headHash: head?.hash };
  });

  out.checks.db = _safe(() => {
    db.prepare(`SELECT 1 AS x`).get();
    return { ok: true };
  });

  out.checks.disk = _safe(() => {
    try {
      const stats = fs.statfsSync(process.cwd());
      const totalMb = Math.floor((stats.blocks * stats.bsize) / 1024 / 1024);
      const freeMb = Math.floor((stats.bavail * stats.bsize) / 1024 / 1024);
      const usedPct = Math.round(((stats.blocks - stats.bavail) / stats.blocks) * 100);
      return { ok: usedPct < 95, usedPct, freeMb, totalMb };
    } catch (e) {
      return { ok: false, error: 'statfs_failed', message: String(e.message || e) };
    }
  });

  out.checks.gateway = _safe(() => {
    const mem = process.memoryUsage();
    return {
      ok: true,
      uptimeSec: Math.floor(process.uptime()),
      rssMb: Math.floor(mem.rss / 1024 / 1024),
      heapMb: Math.floor(mem.heapUsed / 1024 / 1024),
    };
  });

  out.ok = Object.values(out.checks).every(c => c.ok !== false);
  return out;
}

module.exports = { check };
