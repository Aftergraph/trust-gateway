'use strict';
// FS-G2 — operator observability snapshot (ROADMAP §8(b)).
//
// ONE pure projection of live gateway state for the operator console:
//
//   snapshot(gw) → {
//     chain:      { ok, length, head },            // verify() scalars
//     telemetry:  { total, byType (top-5 counts), lastAt },
//     approvals:  { pendingCount },
//     apikeys:    { active, rateLimitedLast1h },
//     tenants:    { count, disabled },
//     skills:     { total, shared, federated },    // FS-H3: visibility counts
//     backups:    { count, latestAt, latestChainHead }, // FS-H3: newest manifest
//     events:     { hubClients },                  // FS-H3: SSE client count
//     uptimeSec, generatedAt
//   }
//
// Rules:
//   - SCALARS ONLY: every leaf is string/number/boolean/null. No raw
//     telemetry payloads, no token material, no args, no tenant rows.
//   - No caching: computed per call; the only memory kept is the top-5
//     byType map built from the ring the caller already holds.
//   - Fail-open per section: a missing store (e.g. api_keys table never
//     created) yields zero-count scalars, never a throw — observability
//     must not become a new failure mode.
//   - Honest limitation: the apikeys store records only SUCCESSFUL hits in
//     rate_hits (blocked attempts are not persisted), so
//     rateLimitedLast1h is a best-effort count of keys whose recorded
//     window count reached their rate.max in a window that started within
//     the last hour — not an exact block log.

const fs = require('node:fs');
const path = require('node:path');

const HOUR_MS = 3_600_000;
const TOP_TYPES = 5;
const MAX_BACKUP_MANIFESTS = 10; // FS-H3: cap manifest reads, newest first

function topByType(events) {
  const counts = new Map();
  for (const e of events) counts.set(e.type, (counts.get(e.type) || 0) + 1);
  const out = {};
  [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
    .slice(0, TOP_TYPES)
    .forEach(([t, c]) => { out[t] = c; });
  return out;
}

function chainSection(gw) {
  try {
    const v = gw.chain.verify(); // {ok, length, head, chainId}
    return {
      ok: !!v.ok,
      length: Number.isFinite(v.length) ? v.length : 0,
      head: typeof v.head === 'string' ? v.head : null,
    };
  } catch {
    return { ok: false, length: 0, head: null };
  }
}

function telemetrySection(gw) {
  const ring = gw.telemetry;
  if (!ring || !Array.isArray(ring.events)) {
    return { total: 0, byType: {}, lastAt: null };
  }
  let lastAt = null;
  for (const e of ring.events) {
    if (e && typeof e.ts === 'number' && (lastAt === null || e.ts > lastAt)) lastAt = e.ts;
  }
  return { total: ring.events.length, byType: topByType(ring.events), lastAt };
}

function approvalsSection(gw) {
  try {
    return { pendingCount: gw.approvals.listPending().length };
  } catch {
    return { pendingCount: 0 };
  }
}

function apikeysSection() {
  // Read the shared SQLite connection directly — instantiating the store
  // here would CREATE tables as a side effect of a read-only snapshot.
  const empty = { active: 0, rateLimitedLast1h: 0 };
  try {
    const { db } = require('./db');
    const has = (name) =>
      !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name);
    if (!has('api_keys')) return empty;
    const active = db.prepare('SELECT COUNT(*) AS n FROM api_keys WHERE disabled = 0').get().n;
    let rateLimitedLast1h = 0;
    if (has('rate_hits')) {
      const since = Date.now() - HOUR_MS;
      rateLimitedLast1h = db.prepare(`
        SELECT COUNT(DISTINCT h.key_id) AS n
        FROM rate_hits h JOIN api_keys k ON k.id = h.key_id
        WHERE k.rate IS NOT NULL
          AND h.window_start >= ?
          AND h.count >= CAST(json_extract(k.rate, '$.max') AS INTEGER)
      `).get(since).n;
    }
    return { active, rateLimitedLast1h };
  } catch {
    return empty;
  }
}

function tenantsSection(gw) {
  try {
    const { getTenantStore } = require('./tenants');
    const list = getTenantStore(gw).list();
    let disabled = 0;
    for (const t of list) if (t.disabled) disabled++;
    return { count: list.length, disabled };
  } catch {
    return { count: 0, disabled: 0 };
  }
}

// ── FS-H3: observability depth ──────────────────────────────────────────

function skillsSection(gw) {
  try {
    const { getSkillStore } = require('./skills');
    const list = getSkillStore(gw).list();
    let shared = 0;
    let federated = 0;
    for (const s of list) {
      if (s.visibility === 'shared') shared++;
      else if (s.visibility === 'federated') federated++;
    }
    return { total: list.length, shared, federated };
  } catch {
    return { total: 0, shared: 0, federated: 0 };
  }
}

function backupsSection() {
  // FS-H3: read data/backups/ manifests (newest first, capped at 10). Only
  // scalars are projected — never the per-file entries. Fail-open: a missing
  // or corrupt manifest yields honest zeros/null, never a throw.
  const empty = { count: 0, latestAt: null, latestChainHead: null };
  try {
    const backup = require('./backup');
    // Mirror backup.js's root resolution (TG_DATA_DIR → cwd/data/backups).
    const dataDir = process.env.TG_DATA_DIR || path.join(process.cwd(), 'data');
    const root = path.join(dataDir, 'backups');
    const names = backup.listBackupNames(root).slice(-MAX_BACKUP_MANIFESTS).reverse();
    if (!names.length) return empty;
    let latestAt = null;
    let latestChainHead = null;
    for (const name of names) {
      try {
        const m = backup.readManifest(path.join(root, name));
        if (latestAt === null && m && typeof m.createdAt === 'string') latestAt = m.createdAt;
        if (latestChainHead === null && m && typeof m.chainHead === 'string') latestChainHead = m.chainHead;
        if (latestAt !== null) break;
      } catch { /* corrupt manifest → skip, keep counting */ }
    }
    return { count: names.length, latestAt, latestChainHead };
  } catch {
    return empty;
  }
}

function eventsSection(gw) {
  try {
    const { getHub } = require('./events');
    return { hubClients: getHub(gw).clientCount() };
  } catch {
    return { hubClients: 0 };
  }
}

function snapshot(gw) {
  return {
    chain: chainSection(gw),
    telemetry: telemetrySection(gw),
    approvals: approvalsSection(gw),
    apikeys: apikeysSection(),
    tenants: tenantsSection(gw),
    skills: skillsSection(gw),
    backups: backupsSection(),
    events: eventsSection(gw),
    uptimeSec: Math.round(process.uptime()),
    generatedAt: new Date().toISOString(),
  };
}

module.exports = { snapshot, HOUR_MS, TOP_TYPES };
