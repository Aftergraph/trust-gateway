'use strict';

const fs = require('node:fs');
const path = require('node:path');

const STATES = new Set([
  'admitted',
  'pending_approval',
  'approved',
  'denied',
  'expired',
  'dispatched',
  'completed',
  'failed',
]);

class ToolActionProposalStore {
  constructor({ file = null, now = () => Date.now(), ttlMs = 15 * 60 * 1000 } = {}) {
    this.file = file;
    this.now = now;
    this.ttlMs = ttlMs;
    this.byRequestId = new Map();
    this.byIdempotency = new Map();
    if (file && fs.existsSync(file)) this._load();
  }

  _load() {
    let rows;
    try { rows = JSON.parse(fs.readFileSync(this.file, 'utf8')); }
    catch { throw new Error('tool-actions: file unparseable — refusing to load (fail closed)'); }
    if (!Array.isArray(rows)) throw new Error('tool-actions: file must be a JSON array');
    for (const row of rows) {
      this._validatePersisted(row);
      this.byRequestId.set(row.requestId, row);
      this.byIdempotency.set(this._idemKey(row.tenantId, row.idempotencyKey), row.requestId);
    }
    this.sweep();
  }

  _save() {
    if (!this.file) return;
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = this.file + '.tmp';
    const rows = [...this.byRequestId.values()];
    fs.writeFileSync(tmp, JSON.stringify(rows) + '\n', { mode: 0o600 });
    fs.renameSync(tmp, this.file);
    try { fs.chmodSync(this.file, 0o600); } catch {}
  }

  _validatePersisted(row) {
    if (!row || typeof row !== 'object') throw new Error('tool-actions: invalid row');
    for (const key of ['requestId','tenantId','toolId','capability','toolProvenanceDigest','principalId','missionId','executionContextId','idempotencyKey','state']) {
      if (!String(row[key] || '').trim()) throw new Error('tool-actions: persisted row missing ' + key);
    }
    if (!STATES.has(row.state)) throw new Error('tool-actions: invalid persisted state');
    if ('arguments' in row || 'credentials' in row || 'secret' in row || 'token' in row || 'apiKey' in row) {
      throw new Error('tool-actions: persisted secret/arguments field forbidden');
    }
  }

  _idemKey(tenantId, idempotencyKey) {
    return String(tenantId) + '\u0000' + String(idempotencyKey);
  }

  createOrGet({ tenantId, request, admission }) {
    for (const [name, value] of Object.entries({
      tenantId,
      requestId: request?.requestId,
      toolId: request?.toolId,
      capability: request?.capability,
      toolProvenanceDigest: request?.toolProvenanceDigest,
      principalId: request?.principalId,
      missionId: request?.missionId,
      executionContextId: request?.executionContextId,
      idempotencyKey: request?.idempotencyKey,
    })) {
      if (!String(value || '').trim()) return { ok: false, error: name + '_required', proposal: null };
    }
    if (!/^[a-f0-9]{64}$/i.test(request.toolProvenanceDigest)) {
      return { ok: false, error: 'tool_provenance_digest_invalid', proposal: null };
    }
    if (request.argumentsDigest != null && !/^[a-f0-9]{64}$/i.test(request.argumentsDigest)) {
      return { ok: false, error: 'arguments_digest_invalid', proposal: null };
    }
    if (!admission || !['admitted', 'pending_approval', 'denied'].includes(admission.decision)) {
      return { ok: false, error: 'admission_decision_invalid', proposal: null };
    }
    const idemKey = this._idemKey(tenantId, request.idempotencyKey);
    const priorRequestId = this.byIdempotency.get(idemKey);
    if (priorRequestId) {
      const prior = this.byRequestId.get(priorRequestId);
      if (!prior) throw new Error('tool-actions: idempotency index corrupt');
      const sameIdentity =
        prior.requestId === request.requestId &&
        prior.toolId === request.toolId &&
        prior.capability === request.capability &&
        prior.toolProvenanceDigest === request.toolProvenanceDigest &&
        prior.principalId === request.principalId &&
        prior.missionId === request.missionId &&
        prior.executionContextId === request.executionContextId &&
        (prior.argumentsDigest || null) === (request.argumentsDigest || null);
      if (!sameIdentity) return { ok: false, error: 'idempotency_conflict', proposal: prior };
      return { ok: true, created: false, proposal: this._expireIfNeeded(prior) };
    }

    if (this.byRequestId.has(request.requestId)) {
      return { ok: false, error: 'request_id_conflict', proposal: this.byRequestId.get(request.requestId) };
    }

    const now = this.now();
    const state = admission.decision === 'pending_approval'
      ? 'pending_approval'
      : admission.decision === 'admitted'
        ? 'admitted'
        : 'denied';

    const proposal = {
      schemaVersion: 'aftergraph.tool-action-proposal/v1',
      requestId: request.requestId,
      tenantId,
      toolId: request.toolId,
      capability: request.capability,
      toolProvenanceDigest: request.toolProvenanceDigest,
      principalId: request.principalId,
      missionId: request.missionId,
      executionContextId: request.executionContextId,
      idempotencyKey: request.idempotencyKey,
      argumentsDigest: request.argumentsDigest || null,
      classification: admission.classification || null,
      reasonCode: admission.reasonCode || null,
      state,
      needsYouId: null,
      createdAt: now,
      updatedAt: now,
      expiresAt: state === 'pending_approval' ? now + this.ttlMs : null,
      resolvedAt: null,
      resolvedBy: null,
      dispatchRef: null,
      receiptRef: null,
    };

    this.byRequestId.set(proposal.requestId, proposal);
    this.byIdempotency.set(idemKey, proposal.requestId);
    this._save();
    return { ok: true, created: true, proposal };
  }

  attachNeedsYou(requestId, needsYouId) {
    const proposal = this._must(requestId);
    if (proposal.state !== 'pending_approval') return { ok: false, error: 'not_pending_approval', proposal };
    if (proposal.needsYouId && proposal.needsYouId !== needsYouId) {
      return { ok: false, error: 'needs_you_conflict', proposal };
    }
    proposal.needsYouId = needsYouId;
    proposal.updatedAt = this.now();
    this._save();
    return { ok: true, proposal };
  }

  decide(requestId, decision, operator) {
    const proposal = this._expireIfNeeded(this._must(requestId));
    if (proposal.state !== 'pending_approval') return { ok: false, error: 'not_pending_approval', proposal };
    if (!proposal.needsYouId) return { ok: false, error: 'needs_you_missing', proposal };
    if (decision !== 'approve' && decision !== 'deny') return { ok: false, error: 'bad_decision', proposal };
    if (!String(operator || '').trim()) return { ok: false, error: 'operator_required', proposal };

    proposal.state = decision === 'approve' ? 'approved' : 'denied';
    proposal.resolvedAt = this.now();
    proposal.resolvedBy = operator;
    proposal.updatedAt = proposal.resolvedAt;
    this._save();
    return { ok: true, proposal };
  }

  get(requestId) {
    const row = this.byRequestId.get(requestId);
    return row ? this._expireIfNeeded(row) : null;
  }

  listPending(tenantId = null) {
    this.sweep();
    return [...this.byRequestId.values()].filter((row) =>
      row.state === 'pending_approval' && (!tenantId || row.tenantId === tenantId)
    );
  }

  sweep() {
    let changed = false;
    for (const row of this.byRequestId.values()) {
      const before = row.state;
      this._expireIfNeeded(row, false);
      if (row.state !== before) changed = true;
    }
    if (changed) this._save();
  }

  _expireIfNeeded(row, save = true) {
    if (row.state === 'pending_approval' && row.expiresAt != null && this.now() > row.expiresAt) {
      row.state = 'expired';
      row.updatedAt = this.now();
      if (save) this._save();
    }
    return row;
  }

  _must(requestId) {
    const row = this.byRequestId.get(requestId);
    if (!row) throw Object.assign(new Error('tool_action_not_found'), { code: 'tool_action_not_found' });
    return row;
  }
}

const gatewayStores = new WeakMap();

function getToolActionProposalStore(gw, {
  file = process.env.TG_TOOL_ACTIONS_FILE || 'data/tool-actions.json',
  now,
  ttlMs,
} = {}) {
  if (!gw || (typeof gw !== 'object' && typeof gw !== 'function')) {
    throw new Error('tool-actions: gateway instance required');
  }
  let store = gatewayStores.get(gw);
  if (!store) {
    store = new ToolActionProposalStore({
      file,
      ...(now ? { now } : {}),
      ...(ttlMs ? { ttlMs } : {}),
    });
    gatewayStores.set(gw, store);
  }
  return store;
}

module.exports = { ToolActionProposalStore, getToolActionProposalStore, STATES };
