/**
 * Designates THE platform owner. NOT run by the application, NOT run by CI, NOT executed anywhere by the person who wrote it.
 *
 *   DATABASE_URL=... npx tsx scripts/set-platform-owner.ts --user-id <uuid>                       # dry run: shows WHICH database and WHICH account, changes nothing
 *   DATABASE_URL=... npx tsx scripts/set-platform-owner.ts --user-id <uuid> --confirm-id <uuid>   # writes, only if the second id equals the first
 *
 * The owner states the account (id from the server, not a name or an e-mail seen in a screenshot) and the environment; the dry run prints both so they can be checked
 * before the confirmed run. Rules: the account must exist, be an ADMIN / SUPER_ADMIN account and ACTIVE; there is exactly one owner (a second run is refused: moving the
 * ownership is outside this batch); no role, permission or staff row is created or changed. The write is one audit row + one owner row in one transaction.
 */
import dotenv from 'dotenv';
dotenv.config();
import { prisma } from '../src/config/db';

const arg = (name: string) => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1] : undefined; };
const mask = (e: string) => { const [u, d] = e.split('@'); return `${u.slice(0, 2)}***@${d}`; };
const dbHint = () => { try { const u = new URL(process.env.DATABASE_URL ?? ''); return `${u.hostname}:${u.port || '5432'}${u.pathname}`; } catch { return '(DATABASE_URL not set or unreadable)'; } };

async function main() {
	const userId = arg('user-id'), confirm = arg('confirm-id');
	if (!userId || !/^[0-9a-f-]{36}$/i.test(userId)) throw new Error('--user-id <uuid> is required');
	console.log(`database : ${dbHint()}`);
	const existing = await prisma.platformOwner.findFirst();
	if (existing) throw new Error(`REFUSED: an owner already exists (${existing.userId}). Moving the ownership is not part of this batch.`);
	const u = await prisma.user.findUnique({ where: { id: userId }, select: { id: true, email: true, firstName: true, lastName: true, accountType: true, status: true, createdAt: true, lastActiveAt: true } });
	if (!u) throw new Error('REFUSED: no such account in THIS database.');
	console.log(`account  : ${u.id}\n  e-mail : ${mask(u.email)}\n  name   : ${u.firstName} ${u.lastName}\n  type   : ${u.accountType}\n  status : ${u.status}\n  created: ${u.createdAt.toISOString()}\n  active : ${u.lastActiveAt?.toISOString() ?? 'never'}`);
	if (u.accountType !== 'ADMIN' && u.accountType !== 'SUPER_ADMIN') throw new Error('REFUSED: the owner must be an ADMIN or SUPER_ADMIN account.');
	if (u.status !== 'ACTIVE') throw new Error('REFUSED: the account is not ACTIVE.');
	if (confirm !== userId) { console.log('\nDRY RUN: nothing was written. Re-run with --confirm-id <the same id> after the owner has checked the database and the account above.'); return; }
	await prisma.$transaction(async tx => {
		await tx.platformOwner.create({ data: { userId, designatedBy: `script:${process.env.USER ?? 'unknown'}` } });
		await tx.adminAccessAudit.create({ data: { actorId: userId, action: 'OWNER_DESIGNATED', subjectUserId: userId, after: { accountType: u.accountType } } });
	});
	console.log('\nDONE: the platform owner is set. No role, permission or staff row was created or changed.');
}
main().catch(e => { console.error(String(e.message ?? e)); process.exitCode = 1; }).finally(() => prisma.$disconnect());
