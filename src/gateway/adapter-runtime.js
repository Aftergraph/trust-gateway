'use strict';

const { AdapterCredentialLifecycle, AdapterScopedHandleStore } = require('./adapter-credentials');
const { createGovernedEgressBroker } = require('./governed-egress');

function fail(code) {
  const err = new Error(code);
  err.code = code;
  return err;
}

function requireFunction(name, value) {
  if (typeof value !== 'function') throw fail('adapter_runtime_' + name + '_required');
}

function createAdapterRuntime(options = {}) {
  const {
    vault,
    handles,
    tenantStore,
    adapterContextResolver,
    authorityCheck,
    approvalCheck,
    destinationPolicy,
    credentialInjector,
    transport,
    transportOptions,
    commitGuard,
    audit,
    now,
  } = options;

  if (!vault) throw fail('adapter_runtime_vault_required');
  if (!handles) throw fail('adapter_runtime_handles_required');
  if (!tenantStore) throw fail('adapter_runtime_tenant_store_required');
  requireFunction('context_resolver', adapterContextResolver);
  requireFunction('authority_check', authorityCheck);
  requireFunction('approval_check', approvalCheck);
  requireFunction('credential_injector', credentialInjector);
  requireFunction('commit_guard', commitGuard);
  requireFunction('audit', audit);
  if (!Array.isArray(destinationPolicy) || destinationPolicy.length === 0) {
    throw fail('adapter_runtime_destination_policy_required');
  }
  if (typeof transport !== 'function' && (!transportOptions || typeof transportOptions !== 'object')) {
    throw fail('adapter_runtime_transport_required');
  }

  const adapterCredentialLifecycle = new AdapterCredentialLifecycle({ vault, handles, tenantStore });
  const scopedHandleStore = new AdapterScopedHandleStore({ handles });
  const governedEgressBroker = createGovernedEgressBroker({
    handleStore: scopedHandleStore,
    now,
    authorityCheck,
    approvalCheck,
    destinationPolicy,
    credentialInjector,
    transport,
    transportOptions,
    commitGuard,
    audit,
    requireAdapterBinding: true,
  });

  return {
    adapterCredentialLifecycle,
    adapterContextResolver,
    governedEgressBroker,
  };
}

module.exports = { createAdapterRuntime };
