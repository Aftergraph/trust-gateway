'use strict';

// Platform Convergence V2.1 identity compatibility boundary.
//
// Local Trust Gateway tenant slugs and authentication identities remain the
// runtime source inputs. This module gives them stable canonical cross-repo
// identifiers without turning identity into authority.

const crypto = require('node:crypto');
const dbmod = require('./db');
const { isValidTenantId } = require('./tenants');
const { resolveTenant } = require('./tenant-resolve');

const ORG_ID_RE = /^org_[a-f0-9]{32}$/;
const TENANT_ID_RE = /^ten_[a-f0-9]{32}$/;
const PRINCIPAL_TYPES = new Set(['human', 'agent', 'service', 'worker']);

function newId(prefix) {
  return `${prefix}_${crypto.randomBytes(16).toString('hex')}`;
}

function ensureTenantBinding({ localTenantId, organizationId }) {
  if (!isValidTenantId(localTenantId)) throw new Error('invalid local tenant id');

  const existing = dbmod.db.prepare(`
    SELECT local_tenant_id, tenant_id, organization_id, created_at
    FROM platform_tenant_bindings
    WHERE local_tenant_id = ?
  `).get(localTenantId);
  if (existing) return existing;

  if (typeof organizationId !== 'string' || !ORG_ID_RE.test(organizationId)) {
    throw new Error('invalid organization_id');
  }

  return dbmod.tx(() => {
    const raced = dbmod.db.prepare(`
      SELECT local_tenant_id, tenant_id, organization_id, created_at
      FROM platform_tenant_bindings
      WHERE local_tenant_id = ?
    `).get(localTenantId);
    if (raced) return raced;

    const createdAt = new Date().toISOString();
    for (let attempt = 0; attempt < 4; attempt++) {
      const tenantId = newId('ten');
      try {
        dbmod.db.prepare(`
          INSERT INTO platform_tenant_bindings
            (local_tenant_id, tenant_id, organization_id, created_at)
          VALUES (?, ?, ?, ?)
        `).run(localTenantId, tenantId, organizationId, createdAt);
        return {
          local_tenant_id: localTenantId,
          tenant_id: tenantId,
          organization_id: organizationId,
          created_at: createdAt,
        };
      } catch (err) {
        const concurrent = dbmod.db.prepare(`
          SELECT local_tenant_id, tenant_id, organization_id, created_at
          FROM platform_tenant_bindings
          WHERE local_tenant_id = ?
        `).get(localTenantId);
        if (concurrent) return concurrent;
        if (attempt === 3) throw err;
      }
    }
    throw new Error('tenant binding unavailable');
  });
}

function ensurePrincipalBinding({ tenantId, identityRef, principalType }) {
  if (typeof tenantId !== 'string' || !TENANT_ID_RE.test(tenantId)) {
    throw new Error('invalid tenant_id');
  }
  if (typeof identityRef !== 'string' || identityRef.length === 0) {
    throw new Error('invalid identity_ref');
  }
  if (!PRINCIPAL_TYPES.has(principalType)) {
    throw new Error('invalid principal_type');
  }

  const existing = dbmod.db.prepare(`
    SELECT tenant_id, identity_ref, principal_id, principal_type, status, created_at
    FROM platform_principal_bindings
    WHERE tenant_id = ? AND identity_ref = ?
  `).get(tenantId, identityRef);
  if (existing) {
    if (existing.principal_type !== principalType) {
      throw new Error('principal type mismatch');
    }
    return existing;
  }

  return dbmod.tx(() => {
    const raced = dbmod.db.prepare(`
      SELECT tenant_id, identity_ref, principal_id, principal_type, status, created_at
      FROM platform_principal_bindings
      WHERE tenant_id = ? AND identity_ref = ?
    `).get(tenantId, identityRef);
    if (raced) {
      if (raced.principal_type !== principalType) throw new Error('principal type mismatch');
      return raced;
    }

    const createdAt = new Date().toISOString();
    for (let attempt = 0; attempt < 4; attempt++) {
      const principalId = newId('prn');
      try {
        dbmod.db.prepare(`
          INSERT INTO platform_principal_bindings
            (tenant_id, identity_ref, principal_id, principal_type, status, created_at)
          VALUES (?, ?, ?, ?, 'active', ?)
        `).run(tenantId, identityRef, principalId, principalType, createdAt);
        return {
          tenant_id: tenantId,
          identity_ref: identityRef,
          principal_id: principalId,
          principal_type: principalType,
          status: 'active',
          created_at: createdAt,
        };
      } catch (err) {
        const concurrent = dbmod.db.prepare(`
          SELECT tenant_id, identity_ref, principal_id, principal_type, status, created_at
          FROM platform_principal_bindings
          WHERE tenant_id = ? AND identity_ref = ?
        `).get(tenantId, identityRef);
        if (concurrent) {
          if (concurrent.principal_type !== principalType) throw new Error('principal type mismatch');
          return concurrent;
        }
        if (attempt === 3) throw err;
      }
    }
    throw new Error('principal binding unavailable');
  });
}

function resolvePlatformIdentity(req, gw) {
  const bot = gw._auth(req);
  req.bot = bot;
  const { tenant } = resolveTenant(req, gw);
  if (!tenant) return { status: 404, body: { error: 'not_found' } };

  const user = typeof gw._currentUser === 'function' ? gw._currentUser(req) : null;
  let identityRef;
  let principalType;
  if (user && !user.disabled) {
    identityRef = `user:${user.id}`;
    principalType = 'human';
  } else if (user && user.disabled) {
    return { status: 401, body: { error: 'unauthorized' } };
  } else if (bot) {
    identityRef = `bot:${bot.name}`;
    principalType = 'agent';
  } else {
    return { status: 401, body: { error: 'unauthorized' } };
  }

  try {
    const tenantBinding = ensureTenantBinding({
      localTenantId: tenant.id,
      organizationId: process.env.TG_PLATFORM_ORG_ID,
    });
    const principal = ensurePrincipalBinding({
      tenantId: tenantBinding.tenant_id,
      identityRef,
      principalType,
    });
    return {
      status: 200,
      body: {
        schema: 'platform-identity-projection/1.0',
        organization_id: tenantBinding.organization_id,
        tenant_id: tenantBinding.tenant_id,
        principal_id: principal.principal_id,
        principal_type: principal.principal_type,
      },
    };
  } catch {
    return { status: 503, body: { error: 'platform_identity_unavailable' } };
  }
}

module.exports = {
  ensureTenantBinding,
  ensurePrincipalBinding,
  resolvePlatformIdentity,
};
