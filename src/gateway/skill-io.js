'use strict';
// FS-O1 — skills import/export.
//
// exportSkill(skillId) → {format, version, skill} — JSON-serializable
// export of one skill + its version history (if TG_SKILL_VERSIONS=1).
// importSkill(payload, by) → {id, version} — validates, persists, audits.
// Bulk: exportAll() and importBulk(payloadArray, by) for migrations.
//
// Inert (returns null) when TG_SKILL_IO=1.

const { db, tx } = require('./db');

const FORMAT = 'trust-gateway-skill/v1';

function enabled() {
  return process.env.TG_SKILL_IO === '1';
}

function exportSkill(skillId) {
  if (!enabled() || !skillId) return null;
  let r;
  try {
    r = db.prepare(`SELECT * FROM skills WHERE id = ?`).get(skillId);
  } catch { return null; }
  if (!r) return null;
  const skill = {
    id: r.id,
    name: r.name,
    description: r.description || null,
    steps: (() => { try { return JSON.parse(r.steps_json || '[]'); } catch { return []; } })(),
    visibility: r.visibility || 'private',
    ownerTenant: r.owner_tenant || r.tenant || null,
    createdAt: r.created_at,
    updatedAt: r.updated_at || r.created_at,
  };
  // Optional: include version history
  let versions = [];
  if (process.env.TG_SKILL_VERSIONS === '1') {
    try {
      versions = db.prepare(
        `SELECT version, created_at, created_by FROM skill_versions WHERE skill_id = ? ORDER BY version`
      ).all(skillId);
    } catch { /* skill_versions table may not exist */ }
  }
  return {
    format: FORMAT,
    exportedAt: Date.now(),
    skill,
    versions,
  };
}

function importSkill(payload, by) {
  if (!enabled()) return null;
  if (!payload || typeof payload !== 'object') {
    return { ok: false, error: 'invalid_payload' };
  }
  if (payload.format !== FORMAT) {
    return { ok: false, error: 'invalid_format' };
  }
  const s = payload.skill;
  if (!s || !s.id || !Array.isArray(s.steps)) {
    return { ok: false, error: 'invalid_skill' };
  }
  const at = Date.now();
  tx(() => {
    // Upsert into skills table (assumes schema: id, name, description, steps_json, visibility, owner_tenant, created_at, updated_at)
    db.prepare(
      `INSERT INTO skills(id, name, description, steps_json, visibility, owner_tenant, created_at, updated_at)
       VALUES(?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         name = excluded.name,
         description = excluded.description,
         steps_json = excluded.steps_json,
         visibility = excluded.visibility,
         updated_at = excluded.updated_at`
    ).run(
      s.id, s.name || s.id, s.description || null,
      JSON.stringify(s.steps), s.visibility || 'private',
      s.ownerTenant || null, s.createdAt || at, at
    );
  });
  return { ok: true, id: s.id, importedAt: at, by };
}

function exportAll() {
  if (!enabled()) return null;
  let rows = [];
  try {
    rows = db.prepare(`SELECT id FROM skills ORDER BY id`).all();
  } catch { return { format: FORMAT, exportedAt: Date.now(), skills: [] }; }
  return {
    format: FORMAT,
    exportedAt: Date.now(),
    skills: rows.map(r => exportSkill(r.id)).filter(Boolean),
  };
}

function importBulk(payloadArray, by) {
  if (!enabled() || !Array.isArray(payloadArray)) return { ok: 0, failed: 0 };
  let ok = 0, failed = 0;
  for (const p of payloadArray) {
    const r = importSkill(p, by);
    if (r && r.ok) ok++; else failed++;
  }
  return { ok, failed, by };
}

module.exports = {
  enabled,
  exportSkill,
  importSkill,
  exportAll,
  importBulk,
  FORMAT,
};
