import { prisma } from '../config/db';
import { AppError } from '../utils/app-error';
import { logger } from '../config/logger';
import { checkUsername, displayNameOf } from '../utils/username';
import { accountAuditLogService, AuditContext } from './account-logs.service';

/**
 * The username: the name used to deal with others and to appear on the platform. Chosen freely (no review: it is not identity data), independent of the LEGAL name, which it never touches.
 * It is the source of truth for the display; firstName / lastName (read by profile, cards, chat, search and notifications) are kept in step in the SAME transaction (firstName = username,
 * lastName = ''), on the user row and on every role profile that has its own display columns, so no surface can show an older name next to it and none ever shows the legal name.
 */
export interface UsernameView { username: string | null; displayName: string }

export class UsernameService {
	async get(userId: string): Promise<UsernameView> {
		const u = await prisma.user.findUnique({ where: { id: userId }, select: { username: true, firstName: true, lastName: true } });
		if (!u) throw new AppError('تعذر العثور على حساب المستخدم', 404);
		return { username: u.username ?? null, displayName: displayNameOf(u) };
	}

	async set(userId: string, raw: unknown, context?: AuditContext): Promise<UsernameView & { changed: boolean }> {
		const c = checkUsername(raw);
		if (!c.ok) throw new AppError(c.message, 400, undefined, c.code);
		const before = await prisma.user.findUnique({ where: { id: userId }, select: { username: true, firstName: true, lastName: true } });
		if (!before) throw new AppError('تعذر العثور على حساب المستخدم', 404);
		if (before.username === c.value && before.firstName === c.value && before.lastName === '') return { username: c.value, displayName: c.value, changed: false };
		await prisma.$transaction(async (tx) => {
			await tx.user.update({ where: { id: userId }, data: { username: c.value, firstName: c.value, lastName: '' } });
			// per-role display columns (independent of the user row since Phase 3A): kept in step where the role profile exists
			await tx.clientProfile.updateMany({ where: { userId }, data: { firstName: c.value, lastName: '' } });
			await tx.providerProfile.updateMany({ where: { userId }, data: { firstName: c.value, lastName: '' } });
			await tx.affiliateProfile.updateMany({ where: { userId }, data: { firstName: c.value, lastName: '' } });
		});
		await accountAuditLogService.record({ userId, eventType: 'USERNAME_CHANGED', category: 'PROFILE_COMPLETION', title: 'اسم المستخدم', summary: 'تغيّر اسم المستخدم الظاهر على المنصة (الاسم الحقيقي لم يتغيّر)', source: 'USER', severity: 'INFO', context }).catch(e => logger.warn(`[Username] audit failed: ${(e as Error).message}`));
		return { username: c.value, displayName: c.value, changed: true };
	}
}
export const usernameService = new UsernameService();
