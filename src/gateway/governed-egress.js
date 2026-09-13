'use strict';

const { createPinnedTransport } = require('./pinned-transport');
const crypto = require('node:crypto');
const dns = require('node:dns');
const { isPrivateAddress } = require('./webtools');
const { pathWithinPrefix } = require('./path-policy');

function fail(code, details) {
  const err = new Error(code);
  err.code = code;
  if (details !== undefined) err.details = details;
  return err;
}

function canonical(value) {
  if (value === null || value === undefined) return value ?? null;
  if (Array.isArray(value)) return value.map(canonical);
  if (typeof value === 'object') {
    const out = {};
    for (const key of Object.keys(value).sort()) out[key] = canonical(value[key]);
    return out;
  }
  return value;
}

function canonicalHeaders(headers = {}) {
  const out = {};
  for (const [rawKey, rawValue] of Object.entries(headers || {})) {
    const key = String(rawKey).trim().toLowerCase();
    if (!key) continue;
    out[key] = canonical(rawValue);
  }
  return canonical(out);
}

function requestIdentity(request = {}) {
  const destination = request.destination || {};
  const http = request.http || {};
  const data = request.data || {};
  return canonical({
    requestId: request.requestId || null,
    correlationId: request.correlationId || null,
    principalId: request.principalId || null,
    missionId: request.missionId || null,
    authorityRef: request.authorityRef || null,
    purpose: request.purpose || null,
    credentialHandle: request.credentialHandle || null,
    destination: {
      scheme: String(destination.scheme || '').toLowerCase(),
      host: String(destination.host || '').toLowerCase(),
      port: Number(destination.port || 0),
    },
    http: {
      method: String(http.method || '').toUpperCase(),
      path: String(http.path || ''),
      query: canonical(http.query || {}),
      headers: canonicalHeaders(http.headers || {}),
      bodyDigest: http.bodyDigest || null,
    },
    data: {
      sensitivity: canonical(data.sensitivity || []),
      provenanceRefs: canonical(data.provenanceRefs || []),
      lineageId: data.lineageId || null,
    },
  });
}

function requestDigest(request) {
  return crypto.createHash('sha256').update(JSON.stringify(requestIdentity(request))).digest('hex');
}

// Credential injection may add the broker-authorized secret header, but it
// must not change the admitted execution envelope. Headers are intentionally
// excluded here; destination, method, path, query, body digest and governance
// identity remain immutable after admission.
function executionEnvelopeDigest(request) {
  const identity = requestIdentity(request);
  identity.http.headers = {};
  return crypto.createHash('sha256').update(JSON.stringify(identity)).digest('hex');
}

function normalizeLookupRows(rows) {
  if (!Array.isArray(rows) || rows.length === 0) throw fail('destination_unresolved');
  const addresses = [...new Set(rows.map((row) => typeof row === 'string' ? row : row?.address).filter(Boolean))].sort();
  if (addresses.length === 0) throw fail('destination_unresolved');
  for (const address of addresses) {
    if (isPrivateAddress(address)) throw fail('destination_private_address');
  }
  return addresses;
}

function arraysEqual(a, b) {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

function matchDestinationPolicy(request, policy) {
  const destination = request.destination || {};
  const http = request.http || {};
  const host = String(destination.host || '').toLowerCase();
  const scheme = String(destination.scheme || '').toLowerCase();
  const port = Number(destination.port || 0);
  const method = String(http.method || '').toUpperCase();
  const reqPath = String(http.path || '');
  return policy.some((rule) => {
    if (String(rule.host || '').toLowerCase() !== host) return false;
    if (!Array.isArray(rule.schemes) || !rule.schemes.map((v) => String(v).toLowerCase()).includes(scheme)) return false;
    if (!Array.isArray(rule.ports) || !rule.ports.map(Number).includes(port)) return false;
    if (!Array.isArray(rule.methods) || !rule.methods.map((v) => String(v).toUpperCase()).includes(method)) return false;
    if (!Array.isArray(rule.pathPrefixes) || !rule.pathPrefixes.some((prefix) => pathWithinPrefix(reqPath, String(prefix)))) return false;
    return true;
  });
}

function scrubSecret(value, secret) {
  if (!secret) return value;
  if (typeof value === 'string') return value.split(secret).join('[REDACTED]');
  if (Array.isArray(value)) return value.map((v) => scrubSecret(v, secret));
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = scrubSecret(v, secret);
    return out;
  }
  return value;
}

class GovernedEgressBroker {
  constructor({
    handleStore,
    now = () => Date.now(),
    lookup = async (host) => dns.promises.lookup(host, { all: true, verbatim: true }),
    authorityCheck = async () => ({ ok: false, reason: 'authority_checker_missing' }),
    approvalCheck = async () => ({ ok: false, reason: 'approval_checker_missing' }),
    destinationPolicy = [],
    audit = () => {},
    credentialInjector,
    transport,
    commitGuard = async () => ({ ok: false, reason: 'commit_guard_missing' }),
  } = {}) {
    if (!handleStore) throw fail('handle_store_required');
    if (typeof credentialInjector !== 'function') throw fail('credential_injector_required');
    if (typeof transport !== 'function') throw fail('transport_required');
    this.handleStore = handleStore;
    this.now = now;
    this.lookup = lookup;
    this.authorityCheck = authorityCheck;
    this.approvalCheck = approvalCheck;
    this.destinationPolicy = destinationPolicy;
    this.audit = audit;
    this.credentialInjector = credentialInjector;
    this.transport = transport;
    this.commitGuard = commitGuard;
  }

  async _resolvePublic(host) {
    let rows;
    try {
      rows = await this.lookup(host);
    } catch (err) {
      throw fail('destination_unresolved', String(err?.message || err));
    }
    return normalizeLookupRows(rows);
  }

  _matchPolicy(request) {
    if (!matchDestinationPolicy(request, this.destinationPolicy)) throw fail('destination_unknown');
  }

  async _checkMutableState(request) {
    this.handleStore.validate(request.credentialHandle, request);
    const authority = await this.authorityCheck(request);
    if (!authority || authority.ok !== true) throw fail('authority_revoked', authority?.reason);
    const approval = await this.approvalCheck(request);
    if (!approval || approval.ok !== true) throw fail('approval_missing_or_revoked', approval?.reason);
    if (approval.expiresAt != null && Number(this.now()) >= Number(approval.expiresAt)) throw fail('approval_expired');
    return { authority, approval };
  }

  async admit(request) {
    this._matchPolicy(request);
    const addresses = await this._resolvePublic(String(request.destination?.host || ''));
    const { authority, approval } = await this._checkMutableState(request);
    const digest = requestDigest(request);
    const admittedAt = Number(this.now());
    const admission = {
      admissionId: `ega_${digest.slice(0, 24)}`,
      requestId: request.requestId || null,
      correlationId: request.correlationId || null,
      requestDigest: digest,
      resolvedAddresses: addresses,
      authorityVersion: authority.version || null,
      approvalExpiresAt: approval.expiresAt ?? null,
      admittedAt,
    };
    this.audit({
      type: 'egress_admitted',
      admissionId: admission.admissionId,
      requestId: admission.requestId,
      correlationId: admission.correlationId,
      destinationHost: String(request.destination?.host || '').toLowerCase(),
      method: String(request.http?.method || '').toUpperCase(),
      requestDigest: digest,
      ts: admittedAt,
    });
    return admission;
  }

  async dispatch(admission, request) {
    if (!admission || typeof admission.requestDigest !== 'string') throw fail('admission_invalid');
    const digest = requestDigest(request);
    if (digest !== admission.requestDigest) throw fail('request_mutated_after_admission');
    this._matchPolicy(request);

    // Re-resolve at dispatch and require the concrete address set to remain byte-equivalent.
    // This deliberately fails closed on DNS rotation rather than tolerating rebinding ambiguity.
    const preSecretAddresses = await this._resolvePublic(String(request.destination?.host || ''));
    const admittedAddresses = [...(admission.resolvedAddresses || [])].sort();
    if (!arraysEqual(preSecretAddresses, admittedAddresses)) throw fail('destination_resolution_changed');

    await this._checkMutableState(request);

    // Secret resolution is a privileged broker-only operation. It happens only after
    // admission and is followed by a second mutable-state check immediately before commit.
    const resolved = this.handleStore.resolveForBroker(request.credentialHandle, request);

    const secondAddresses = await this._resolvePublic(String(request.destination?.host || ''));
    if (!arraysEqual(secondAddresses, admittedAddresses)) throw fail('destination_resolution_changed');
    await this._checkMutableState(request);

    // A final mutable-state check alone is subject to TOCTOU. The commit
    // guard must atomically reserve the effect/lease that the connector will
    // consume at transport commit time.
    let commitPermit;
    try {
      commitPermit = await this.commitGuard({
        request,
        admission,
        resolvedAddresses: admittedAddresses,
        requestDigest: digest,
      });
    } catch (err) {
      this.audit({
        type: 'egress_failed',
        admissionId: admission.admissionId,
        requestId: admission.requestId,
        correlationId: admission.correlationId,
        error: String(err?.code || err?.message || 'commit_guard_error'),
        ts: Number(this.now()),
      });
      throw err;
    }
    if (!commitPermit || commitPermit.ok !== true ||
        typeof commitPermit.permitId !== 'string' ||
        commitPermit.permitId.trim() === '') {
      this.audit({
        type: 'egress_failed',
        admissionId: admission.admissionId,
        requestId: admission.requestId,
        correlationId: admission.correlationId,
        error: 'commit_guard_refused',
        ts: Number(this.now()),
      });
      throw fail('commit_guard_refused');
    }

    const injected = this.credentialInjector({ secret: resolved.secret, request });
    if (!injected || typeof injected !== 'object') throw fail('credential_injection_failed');
    if (executionEnvelopeDigest(injected) !== executionEnvelopeDigest(request)) {
      this.audit({
        type: 'egress_failed',
        admissionId: admission.admissionId,
        requestId: admission.requestId,
        correlationId: admission.correlationId,
        error: 'request_mutated_during_credential_injection',
        ts: Number(this.now()),
      });
      throw fail('request_mutated_during_credential_injection');
    }

    let result;
    try {
      result = await this.transport(injected, {
        resolvedAddresses: admittedAddresses,
        permitId: commitPermit.permitId,
        requireAddressPinning: true,
      });
    } catch (err) {
      this.audit({
        type: 'egress_failed',
        admissionId: admission.admissionId,
        requestId: admission.requestId,
        correlationId: admission.correlationId,
        error: String(err?.code || err?.message || 'transport_error'),
        ts: Number(this.now()),
      });
      throw err;
    }

    const connectedAddress = String(result?.connectedAddress || '');
    if (!connectedAddress || !admittedAddresses.includes(connectedAddress)) {
      this.audit({
        type: 'egress_failed',
        admissionId: admission.admissionId,
        requestId: admission.requestId,
        correlationId: admission.correlationId,
        error: 'transport_address_not_pinned',
        ts: Number(this.now()),
      });
      throw fail('transport_address_not_pinned');
    }

    const status = Number(result?.status || 0);
    if (status >= 300 && status < 400) {
      this.audit({
        type: 'egress_redirect_refused',
        admissionId: admission.admissionId,
        requestId: admission.requestId,
        correlationId: admission.correlationId,
        status,
        ts: Number(this.now()),
      });
      throw fail('redirect_requires_readmission');
    }

    const safeResult = scrubSecret(result, resolved.secret);
    this.audit({
      type: 'egress_dispatched',
      admissionId: admission.admissionId,
      requestId: admission.requestId,
      correlationId: admission.correlationId,
      status,
      requestDigest: digest,
      ts: Number(this.now()),
    });
    return safeResult;
  }
}

function createGovernedEgressBroker({ transport, transportOptions, ...options } = {}) {
  const selectedTransport = transport || createPinnedTransport(transportOptions);
  return new GovernedEgressBroker({ ...options, transport: selectedTransport });
}

module.exports = {
  GovernedEgressBroker,
  createGovernedEgressBroker,
  requestDigest,
  requestIdentity,
  matchDestinationPolicy,
};
