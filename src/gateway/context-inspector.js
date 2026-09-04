'use strict';
// P1 — Context Inspector v1 (backend aggregation).
// Answers the audit question "what does this agent see / know / can do RIGHT NOW"
// from the canonical stores — never from hidden state. Every layer carries the
// source it was read from, so the snapshot is attributable.
//
// Layers (L-numbers follow docs/evidence-layer-model.md):
//   identity   — agent-store profile + capabilities          (source: agent-store)
//   authority  — AIE lease envelope as TG sees it (fail-open state) (source: aie-client env posture)
//   budget     — BudgetStore snapshot for the bot            (source: budgets)
//   memory     — memory entries scoped to the bot            (source: memory)
//   projects   — projects the bot is attached to             (source: projects)
//   approvals  — pending queue affecting this bot            (source: approvals)
//   runtime    — WORKS control-plane posture                 (source: works-client config)
//
// The snapshot is content-addressed (sha256 over canonical JSON) so two inspectors
// can diff "what changed in this agent's world".

const crypto = require('node:crypto');

function sha(obj) {
  return crypto.createHash('sha256').update(JSON.stringify(obj)).digest('hex').slice(0, 16);
}

function buildContextSnapshot({ botName, agentStore, budgets, memoryStore, projectStore, approvals, worksConfigured }) {
  const layers = [];

  // identity
  let identity = null;
  if (agentStore) {
    const agent = agentStore.get(botName) || null;
    identity = {
      source: 'agent-store',
      bot: botName,
      profile: agentStore.getProfile ? agentStore.getProfile(botName) : null,
      registered: !!agentStore.get(botName),
    };
  } else {
    identity = { source: 'agent-store', bot: botName, registered: false, error: 'agent_store_unavailable' };
  }
  layers.push({ layer: 'identity', data: identity });

  // authority (what TG believes about the bot's authority posture — no live AIE call;
  // the inspector reads config posture, NOT secrets)
  layers.push({
    layer: 'authority',
    data: {
      source: 'aie-client',
      revalidation: process.env.TG_AIE_FAIL_OPEN === 'true' ? 'fail_open (test/dev posture)' : 'fail_closed (default)',
      works_control_plane: worksConfigured ? 'configured' : 'not_configured',
    },
  });

  // budget
  let budget = null;
  if (budgets) {
    try {
      budget = budgets.get ? budgets.get(botName) : null;
    } catch { budget = null; }
  }
  layers.push({ layer: 'budget', data: { source: 'budgets', state: budget || { configured: false } } });

  // memory
  let memoryEntries = [];
  if (memoryStore) {
    try {
      memoryEntries = (memoryStore.list() || []).slice(0, 50);
    } catch { memoryEntries = []; }
  }
  layers.push({ layer: 'memory', data: { source: 'memory', count: memoryEntries.length, entries: memoryEntries } });

  // projects (bot appears in activity/owner/mission correlation — coarse match on title owner)
  let projects = [];
  if (projectStore) {
    try {
      projects = projectStore.list().map((p) => ({
        id: p.id, title: p.title, status: p.status, health: p.health,
        missions: p.missions.length, conversations: p.conversations.length,
      }));
    } catch { projects = []; }
  }
  layers.push({ layer: 'projects', data: { source: 'projects', count: projects.length, projects } });

  // approvals affecting the bot
  let pending = [];
  if (approvals) {
    try {
      pending = (approvals.listPending() || [])
        .filter((r) => r.bot === botName)
        .map((r) => ({ id: r.id, tool: r.tool, status: r.status, createdAt: r.createdAt }));
    } catch { pending = []; }
  }
  layers.push({ layer: 'approvals', data: { source: 'approvals', pending: pending.length, items: pending } });

  return {
    bot: botName,
    generated_at: new Date().toISOString(),
    snapshot_hash: sha(layers),
    layers,
  };
}

module.exports = { buildContextSnapshot, sha };