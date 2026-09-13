'use strict';

const { isValidTenantId } = require('./tenants');

function fail(code) {
  const err = new Error(code);
  err.code = code;
  return err;
}

const SAFE_IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

function normalizeIdentifier(value) {
  const normalized = String(value ?? '').trim();
  if (!SAFE_IDENTIFIER.test(normalized)) throw fail('adapter_credential_identifier_invalid');
  return normalized;
}

function normalizeSecretName(value) {
  return normalizeIdentifier(value).toLowerCase();
}

function adapterCredentialKey(adapterId, secretName) {
  const id = normalizeIdentifier(adapterId);
  const name = normalizeSecretName(secretName);
  return 'adapters/' + id + '/credentials/' + name;
}

function adapterScope(adapterId) {
  return 'adapter:' + normalizeIdentifier(adapterId);
}

class AdapterCredentialLifecycle {
  constructor({ vault, handles, tenantStore } = {}) {
    if (!vault) throw fail('adapter_credential_vault_required');
    if (!handles) throw fail('adapter_credential_handles_required');
    if (!tenantStore || typeof tenantStore.get !== 'function') throw fail('adapter_credential_tenant_store_required');
    this.vault = vault;
    this.handles = handles;
    this.tenantStore = tenantStore;
  }

  _binding(input = {}) {
    const tenant = String(input.tenant || '').trim().toLowerCase();
    if (!isValidTenantId(tenant)) throw fail('adapter_credential_tenant_invalid');
    const adapterId = normalizeIdentifier(input.adapterId);
    const secretName = normalizeSecretName(input.secretName);
    const tenantRecord = this.tenantStore.get(tenant);
    if (!tenantRecord || tenantRecord.disabled) throw fail('adapter_credential_tenant_unavailable');
    return { tenant, adapterId, secretName, secretKey: adapterCredentialKey(adapterId, secretName), scope: adapterScope(adapterId) };
  }

  _assertHandleBinding(meta, binding) {
    if (!meta || meta.tenant !== binding.tenant) throw fail('adapter_credential_scope_mismatch');
    const scopes = Array.isArray(meta.scopeRefs) ? meta.scopeRefs : [];
    if (!scopes.includes(binding.scope)) throw fail('adapter_credential_scope_mismatch');
    return meta;
  }

  setSecret(input = {}) {
    const binding = this._binding(input);
    if (typeof input.value !== 'string' || input.value.length === 0) throw fail('adapter_credential_value_invalid');
    this.vault.setSecret(binding.tenant, binding.secretKey, input.value);
    return { ok: true, tenant: binding.tenant, adapterId: binding.adapterId, secretName: binding.secretName };
  }

  issueHandle(input = {}) {
    const binding = this._binding(input);
    if (typeof this.vault.listKeys !== 'function' || !this.vault.listKeys(binding.tenant).includes(binding.secretKey)) {
      throw fail('adapter_credential_secret_missing');
    }
    const requestedScopes = Array.isArray(input.scopeRefs) ? input.scopeRefs.map((scope) => String(scope).trim()).filter(Boolean) : [];
    if (requestedScopes.some((scope) => scope.startsWith('adapter:') && scope !== binding.scope)) {
      throw fail('adapter_credential_scope_mismatch');
    }
    const issued = this.handles.issue({
      ...input,
      tenant: binding.tenant,
      secretKey: binding.secretKey,
      scopeRefs: [binding.scope, ...requestedScopes],
    });
    const { secret, secretKey, ...publicIssued } = issued || {};
    return { adapterId: binding.adapterId, secretName: binding.secretName, ...publicIssued };
  }

  inspectHandle({ handleId, tenant, adapterId } = {}) {
    const binding = this._binding({ tenant, adapterId, secretName: 'placeholder' });
    const meta = this.handles.inspect(handleId);
    return { adapterId: binding.adapterId, ...this._assertHandleBinding(meta, binding) };
  }

  revokeHandle({ handleId, tenant, adapterId, reason } = {}) {
    const binding = this._binding({ tenant, adapterId, secretName: 'placeholder' });
    const meta = this.handles.inspect(handleId);
    this._assertHandleBinding(meta, binding);
    const revoked = this.handles.revoke(handleId, reason || 'revoked');
    const { secret, secretKey, ...publicRevoked } = revoked || {};
    return { adapterId: binding.adapterId, ...publicRevoked };
  }

  resolveForBroker({ handleId, tenant, adapterId, request = {} } = {}) {
    const binding = this._binding({ tenant, adapterId, secretName: 'placeholder' });
    const meta = this.handles.inspect(handleId);
    this._assertHandleBinding(meta, binding);
    if (request.tenant !== undefined && request.tenant !== binding.tenant) throw fail('adapter_credential_scope_mismatch');
    return this.handles.resolveForBroker(handleId, { ...request, tenant: binding.tenant });
  }
}

module.exports = { AdapterCredentialLifecycle, adapterCredentialKey, adapterScope };
