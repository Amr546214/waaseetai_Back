import test from 'node:test';
import assert from 'node:assert/strict';
import { presentedIdentity, adminRoleOfAccountType, isAdminAccountType } from './admin-identity';

test('an ADMIN / SUPER_ADMIN account presents its own admin role (never CLIENT, never the other admin role); other accounts are unchanged', () => {
	assert.deepEqual(presentedIdentity({ accountType: 'SUPER_ADMIN' as any, activeRole: 'CLIENT' as any, roles: ['CLIENT'] as any }), { activeRole: 'SUPER_ADMIN', roles: ['SUPER_ADMIN', 'CLIENT'] });
	assert.deepEqual(presentedIdentity({ accountType: 'ADMIN' as any, activeRole: 'CLIENT' as any, roles: ['CLIENT', 'ADMIN'] as any }), { activeRole: 'ADMIN', roles: ['ADMIN', 'CLIENT'] });
	assert.deepEqual(presentedIdentity({ accountType: 'ADMIN' as any, activeRole: 'ADMIN' as any, roles: ['ADMIN'] as any }), { activeRole: 'ADMIN', roles: ['ADMIN'] });
	// ADMIN is never shown SUPER_ADMIN (the role arrays are part of authorization in other middleware)
	assert.ok(!presentedIdentity({ accountType: 'ADMIN' as any, activeRole: 'CLIENT' as any, roles: ['CLIENT'] as any }).roles.includes('SUPER_ADMIN' as any));
	for (const t of ['CLIENT_INDIVIDUAL', 'PROVIDER_COMPANY', 'MARKETING_BROKER']) {
		const u = { accountType: t as any, activeRole: 'PROVIDER' as any, roles: ['CLIENT', 'PROVIDER'] as any };
		assert.deepEqual(presentedIdentity(u), { activeRole: 'PROVIDER', roles: ['CLIENT', 'PROVIDER'] });
	}
	assert.equal(adminRoleOfAccountType('CLIENT_INDIVIDUAL'), null);
	assert.equal(isAdminAccountType('SUPER_ADMIN'), true);
});
