/**
 * READ-ONLY inventory of the admin accounts and what they could reach before the permission system. Writes nothing. Meant to be run by the team on the server (never from a laptop
 * against a shared database), and by the tests / the migration rehearsal against an isolated copy.
 *
 *   DATABASE_URL=... npx tsx scripts/admin-access-inventory.ts           # human readable
 *   DATABASE_URL=... npx tsx scripts/admin-access-inventory.ts --json
 *
 * Per ADMIN / SUPER_ADMIN / EMPLOYEE account: type, status, created, last activity, whether it is in the team / the owner, how many admin actions it recorded in the last 90 days
 * (account_audit_logs source ADMIN, by the account's own id). The e-mail is masked.
 */
import dotenv from 'dotenv';
dotenv.config();
import { prisma } from '../src/config/db';

const mask = (e: string) => { const [u, d] = e.split('@'); return `${u.slice(0, 2)}***@${d}`; };
async function main() {
	const since = new Date(Date.now() - 90 * 86400_000);
	const users = await prisma.user.findMany({ where: { accountType: { in: ['ADMIN', 'SUPER_ADMIN', 'EMPLOYEE'] } }, orderBy: { createdAt: 'asc' }, select: { id: true, email: true, firstName: true, lastName: true, accountType: true, status: true, createdAt: true, lastActiveAt: true, roles: true } });
	const [owner, staff, acts] = await Promise.all([
		prisma.platformOwner.findFirst({ select: { userId: true } }).catch(() => null),
		prisma.adminStaff.findMany({ select: { userId: true, status: true, role: { select: { name: true } } } }).catch(() => []),
		prisma.accountAuditLog.groupBy({ by: ['userId'], where: { source: 'ADMIN', occurredAt: { gte: since } }, _count: { _all: true } }).catch(() => []),
	]);
	const st = new Map(staff.map(s => [s.userId, s])), ac = new Map(acts.map(a => [a.userId, a._count._all]));
	const rows = users.map(u => ({ id: u.id, email: mask(u.email), name: `${u.firstName} ${u.lastName}`.trim(), accountType: u.accountType, status: u.status, createdAt: u.createdAt, lastActiveAt: u.lastActiveAt, storedRoles: u.roles,
		isOwner: owner?.userId === u.id, inTeam: st.has(u.id), teamStatus: st.get(u.id)?.status ?? null, teamRole: st.get(u.id)?.role?.name ?? null, adminActionsLast90d: ac.get(u.id) ?? 0,
		accessAfterSwitch: owner?.userId === u.id ? 'كل الصلاحيات (المالك)' : st.get(u.id)?.status === 'ACTIVE' && st.get(u.id)?.role ? `صلاحيات الدور «${st.get(u.id)!.role!.name}»` : 'لا شيء (حتى يضعه المالك في الفريق)' }));
	if (process.argv.includes('--json')) { console.log(JSON.stringify({ generatedAt: new Date(), ownerSet: !!owner, accounts: rows }, null, 2)); return; }
	console.log(`owner designated: ${owner ? 'yes' : 'NO (nobody can manage the team until the owner is set)'}\nadmin-type accounts: ${rows.length}\n`);
	for (const r of rows) console.log(`${r.id}  ${r.accountType.padEnd(11)} ${r.status.padEnd(10)} ${r.email.padEnd(22)} last:${r.lastActiveAt?.toISOString().slice(0, 10) ?? 'never'}  actions90d:${r.adminActionsLast90d}  -> ${r.accessAfterSwitch}`);
}
main().catch(e => { console.error(String(e.message ?? e)); process.exitCode = 1; }).finally(() => prisma.$disconnect());
