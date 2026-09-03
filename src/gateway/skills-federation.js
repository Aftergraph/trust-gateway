'use strict';
// FS-H2 — federation run ledger + cross-tenant dry-run limits.
//
// FS-G1 made a 'federated' skill dry-runnable by bots of OTHER tenants.
// This slice adds HONEST accounting and abuse limits around exactly that
// surface — real (non-dry) cross-tenant runs are NOT federated here; they
// stay approval-gated per running tenant exactly as FS-G1 landed them.
//
// FedRunLedger: a `fed_runs` table on the SHARED db.js connection (same
// pattern as tenants.js — DB authoritative, no in-memory cache):
//   fed_runs(id INTEGER PRIMARY KEY, skill_id TEXT, owner_tenant TEXT,
//            runner_tenant TEXT, runner_bot TEXT, ran_at INTEGER)
// Methods:
//   record({ skillId, ownerTenant, runnerTenant, runnerBot, ranAt? })
//   countByRunner(runnerTenant, windowMs, now?) → runs in the window
//   countBySkill(skillId)             → total runs of that skill (all time)
//   listByRunner(runnerTenant)        → runner-view rows (their bots elsewhere)
//   listByOwner(ownerTenant)          → owner-view rows (who ran theirs)
//
// Limits (enforced in the 105-skills cross-tenant DRY-run path, BEFORE the
// dry-run executes — limits are the SAFE DEFAULT):
//   TG_FED_RUNS_PER_HOUR          default 20  — per runner tenant / hour
//   TG_FED_RUNS_PER_SKILL_HOUR    default 50  — per skill / hour (all runners)
// Env unset/invalid → the default is active (an explicit '0' or garbage
// never disables a limit — fail closed). Over a cap → 429
// { error: 'fed_rate_limited' } + audited skill_fed_limited
// { runnerTenant, skillId }.
//
// Everything here is inert unless TG_SKILLS_FEDERATION=1: the mount route
// gates on federationEnabled() and the run path only reaches the ledger
// when the cross-tenant dry-run condition is already true — with the env
// unset the gateway is byte-identical to pre-FS-H2.

const { db, tx } = require('./db');

const TABLE = 'fed_runs';

class FedRunLedger {
  /**
   * @param {object} [opts]
   * @param {Function} [opts.now] clock override (tests); default Date.now.
   */
  constructor({ now } = {}) {
    this.db = db; // the one shared connection from db.js
    this.now = now ?? (() => Date.now());
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS ${TABLE} (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        skill_id      TEXT NOT NULL,
        owner_tenant  TEXT NOT NULL,
        runner_tenant TEXT NOT NULL,
        runner_bot    TEXT NOT NULL,
        ran_at        INTEGER NOT NULL
      );
    `);
  }

  /** Append one cross-tenant run row. Returns the inserted row id. */
  record({ skillId, ownerTenant, runnerTenant, runnerBot, ranAt } = {}) {
    if (!skillId || !ownerTenant || !runnerTenant || !runnerBot) {
      throw new Error('fed_runs: record() requires skillId, ownerTenant, runnerTenant, runnerBot');
    }
    const at = Number.isFinite(ranAt) ? ranAt : this.now();
    return tx(() => {
      const info = this.db
        .prepare(`INSERT INTO ${TABLE}(skill_id, owner_tenant, runner_tenant, runner_bot, ran_at)
                  VALUES(?, ?, ?, ?, ?)`)
        .run(skillId, ownerTenant, runnerTenant, runnerBot, at);
      return Number(info.lastInsertRowid);
    });
  }

  /** Cross-tenant runs by this runner tenant inside the last windowMs. */
  countByRunner(runnerTenant, windowMs, now) {
    if (!runnerTenant) return 0;
    const at = Number.isFinite(now) ? now : this.now();
    const row = this.db
      .prepare(`SELECT COUNT(*) AS n FROM ${TABLE}
                WHERE runner_tenant = ? AND ran_at > ?`)
      .get(runnerTenant, at - windowMs);
    return Number(row ? row.n : 0);
  }

  /** Total recorded runs of one skill across all runner tenants (all time). */
  countBySkill(skillId) {
    if (!skillId) return 0;
    const row = this.db
      .prepare(`SELECT COUNT(*) AS n FROM ${TABLE} WHERE skill_id = ?`)
      .get(skillId);
    return Number(row ? row.n : 0);
  }

  /** Runner view: every row where this tenant's bots ran skills elsewhere. */
  listByRunner(runnerTenant) {
    if (!runnerTenant) return [];
    return this.db
      .prepare(`SELECT id, skill_id, owner_tenant, runner_tenant, runner_bot, ran_at
                FROM ${TABLE} WHERE runner_tenant = ? ORDER BY id`)
      .all(runnerTenant)
      .map(_row);
  }

  /** Owner view: every row where OTHER tenants ran this tenant's skills. */
  listByOwner(ownerTenant) {
    if (!ownerTenant) return [];
    return this.db
      .prepare(`SELECT id, skill_id, owner_tenant, runner_tenant, runner_bot, ran_at
                FROM ${TABLE} WHERE owner_tenant = ? ORDER BY id`)
      .all(ownerTenant)
      .map(_row);
  }
}

function _row(r) {
  if (!r) return null;
  return {
    id: r.id,
    skillId: r.skill_id,
    ownerTenant: r.owner_tenant,
    runnerTenant: r.runner_tenant,
    runnerBot: r.runner_bot,
    ranAt: r.ran_at,
  };
}

// Module-level singleton — the underlying db.js connection is itself a
// module singleton, so every gateway in the process shares one ledger.
let _ledger = null;

/** Shared FedRunLedger (creates the table on first use). */
function getFedRunLedger(opts = {}) {
  if (!_ledger) _ledger = new FedRunLedger(opts);
  return _ledger;
}

/** Positive-int env parse; anything else → the safe default (fail closed). */
function capFromEnv(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === null || String(raw).trim() === '') return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) return fallback;
  return n;
}

const HOUR_MS = 60 * 60 * 1000;

/** Per-runner-tenant cap: TG_FED_RUNS_PER_HOUR, default 20. */
function fedRunsPerHour() {
  return capFromEnv('TG_FED_RUNS_PER_HOUR', 20);
}

/** Per-skill cap: TG_FED_RUNS_PER_SKILL_HOUR, default 50. */
function fedRunsPerSkillHour() {
  return capFromEnv('TG_FED_RUNS_PER_SKILL_HOUR', 50);
}

const WINDOW_MS = HOUR_MS;

module.exports = {
  FedRunLedger,
  getFedRunLedger,
  capFromEnv,
  fedRunsPerHour,
  fedRunsPerSkillHour,
  WINDOW_MS,
  TABLE,
};
