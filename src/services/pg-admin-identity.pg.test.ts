import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

/**
 * REAL PostgreSQL (isolated local :55432). Admin accounts present their admin role, nothing is written, role switching is refused for them and unchanged for everyone else.
 */
const PG_URL = process.env.QA_ISOLATED_PG_URL;
const enabled = !!PG_URL && PG_URL === process.env.DATABASE_URL && /@(127\.0\.0\.1|localhost):55432\//.test(PG_URL);
const opts = { skip: enabled ? false : 'set QA_ISOLATED_PG_URL (isolated local PostgreSQL on :55432) to run' };
process.env.JWT_SECRET ??= 'test-secret';
const id = () => randomUUID();

async function mk(accountType: string, roles: string[], activeRole: string) {
	const { prisma } = await import('../config/db');
	const tag = id().slice(0, 8);
	return prisma.user.create({ data: { id: id(), accountType: accountType as any, firstName: 'a', lastName: tag, email: `ai-${tag}@pg.test`, roles: roles as any, activeRole: activeRole as any } });
}

test('PG: a SUPER_ADMIN stored as {CLIENT}/CLIENT presents SUPER_ADMIN; an ADMIN {CLIENT,ADMIN}/CLIENT presents ADMIN; the rows are NOT changed', opts, async () => {
	const { accountManagementService } = await import('./account-management.service');
	const { prisma } = await import('../config/db');
	const sup = await mk('SUPER_ADMIN', ['CLIENT'], 'CLIENT');
	const adm = await mk('ADMIN', ['CLIENT', 'ADMIN'], 'CLIENT');
	const s: any = await accountManagementService.getAvailableAccountTypes(sup.id);
	assert.equal(s.activeRole, 'SUPER_ADMIN'); assert.ok(s.roles.includes('SUPER_ADMIN')); assert.deepEqual(s.availableRoles, []);
	const a: any = await accountManagementService.getAvailableAccountTypes(adm.id);
	assert.equal(a.activeRole, 'ADMIN'); assert.ok(!a.roles.includes('SUPER_ADMIN'));
	for (const [u, roles, active] of [[sup, ['CLIENT'], 'CLIENT'], [adm, ['CLIENT', 'ADMIN'], 'CLIENT']] as const) {
		const row = await prisma.user.findUnique({ where: { id: u.id }, select: { roles: true, activeRole: true } });
		assert.deepEqual([...row!.roles].sort(), [...roles].sort()); assert.equal(row!.activeRole, active);
	}
});

test('PG: an admin account cannot switch roles (403 ADMIN_ROLE_SWITCH_NOT_ALLOWED, nothing stored); a multi-role client/provider still switches', opts, async () => {
	const { accountManagementService } = await import('./account-management.service');
	const { prisma } = await import('../config/db');
	const adm = await mk('ADMIN', ['CLIENT', 'ADMIN'], 'CLIENT');
	const e: any = await accountManagementService.switchActiveRole(adm.id, 'CLIENT' as any).catch((x: any) => x);
	assert.equal(e.statusCode, 403); assert.equal(e.code, 'ADMIN_ROLE_SWITCH_NOT_ALLOWED');
	assert.equal((await prisma.user.findUnique({ where: { id: adm.id } }))!.activeRole, 'CLIENT');
	const prov = await mk('PROVIDER_INDIVIDUAL', ['CLIENT', 'PROVIDER'], 'PROVIDER');
	const ok: any = await accountManagementService.switchActiveRole(prov.id, 'CLIENT' as any);
	assert.ok(ok);
	assert.equal((await prisma.user.findUnique({ where: { id: prov.id } }))!.activeRole, 'CLIENT');
});
