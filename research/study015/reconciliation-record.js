'use strict';

function fail(code) {
  const err = new Error(code);
  err.code = code;
  return err;
}

function requireString(value, code) {
  const out = String(value || '').trim();
  if (!out) throw fail(code);
  return out;
}

function validateStudy015ReconciliationRecord(record, expected = {}) {
  if (!record || typeof record !== 'object' || Array.isArray(record)) {
    throw fail('study015_reconciliation_invalid');
  }
  if (record.schema !== 'study015.effect-reconciliation/1.0') {
    throw fail('study015_reconciliation_schema_invalid');
  }
  if (record.status !== 'COMMITTED_RECOVERED') {
    throw fail('study015_reconciliation_status_invalid');
  }

  const out = {
    schema: record.schema,
    status: record.status,
    request_id: requireString(record.request_id, 'study015_reconciliation_request_required'),
    correlation_id: requireString(record.correlation_id, 'study015_reconciliation_correlation_required'),
    execution_context_id: requireString(record.execution_context_id, 'study015_reconciliation_context_required'),
    action_id: requireString(record.action_id, 'study015_reconciliation_action_required'),
    effect_id: requireString(record.effect_id, 'study015_reconciliation_effect_required'),
    repository: requireString(record.repository, 'study015_reconciliation_repository_required'),
    ref: requireString(record.ref, 'study015_reconciliation_ref_required'),
    expected_sha: requireString(record.expected_sha, 'study015_reconciliation_expected_sha_required').toLowerCase(),
    observed_sha: requireString(record.observed_sha, 'study015_reconciliation_observed_sha_required').toLowerCase(),
    observed_via: requireString(record.observed_via, 'study015_reconciliation_source_required'),
  };

  if (!/^[a-f0-9]{40}$/.test(out.expected_sha) || !/^[a-f0-9]{40}$/.test(out.observed_sha)) {
    throw fail('study015_reconciliation_sha_invalid');
  }
  if (out.observed_sha !== out.expected_sha) {
    throw fail('study015_reconciliation_remote_mismatch');
  }
  if (out.observed_via !== 'github_exact_ref_readback') {
    throw fail('study015_reconciliation_source_invalid');
  }

  const bindings = {
    execution_context_id: expected.executionContextId,
    action_id: expected.actionId,
    effect_id: expected.effectId,
    correlation_id: expected.correlationId,
    repository: expected.repository,
    ref: expected.ref,
    expected_sha: expected.expectedSha,
  };
  for (const [key, value] of Object.entries(bindings)) {
    if (value != null && String(value) !== out[key]) {
      throw fail('study015_reconciliation_binding_mismatch');
    }
  }
  return Object.freeze(out);
}

module.exports = { validateStudy015ReconciliationRecord };
