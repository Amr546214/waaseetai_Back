import { Prisma } from '@prisma/client';
import { prisma } from '../config/db';
import { AppError } from '../utils/app-error';
import { logger } from '../config/logger';
import { checkLegalName, sameLegalName } from '../utils/legal-name';
import { LEGAL_NAME_CHANGE_REQUEST_CATEGORY } from '../utils/profile-request-categories';
import { identityFieldCheckService } from './identity-field-check.service';
import { accountAuditLogService, AuditContext } from './account-logs.service';

/**
 * The LEGAL name: the name on the official identity document, the only name compared with it. It is the owner's private data:
 * returned only to the owner (this service) and to the reviewers (identity admin view), never in public profiles, search, chat or notifications.
 * The display name (firstName/lastName) is a different thing; changing it never touches this value and this value never changes it.
 *
 *  - never provided (older accounts, Google sign-ups)  -> status MISSING; verification asks for it
 *  - provided, identity not verified and not under review -> the owner may correct it directly (the identity check runs again)
 *  - identity VERIFIED or PENDING review                  -> a change is only a request (category LEGAL_NAME_CHANGE) that an admin decides; on approval the
 *                                                           name is replaced and the identity goes back to PENDING to be verified against the new name
 */
export type LegalNameStatus = 'MISSING' | 'PROVIDED';
export interface LegalNameView { status: LegalNameStatus; legalName: string | null; changeNeedsReview: boolean; pendingRequest: { id: string; requestedValue: string | null; createdAt: string } | null }

const parties = (kinds: { hasClient: boolean; hasProvider: boolean }) => [...(kinds.hasClient ? ['CLIENT' as const] : []), ...(kinds.hasProvider ? ['PROVIDER' as const] : [])];

async function identityState(userId: string) {
	const [client, provider] = await Promise.all([
		prisma.clientProfile.findUnique({ where: { userId }, select: { kycStatus: true } }),
		prisma.providerProfile.findUnique({ where: { userId }, select: { kycStatus: true } })
	]);
	const governed = [client?.kycStatus, provider?.kycStatus].some(s => s === 'VERIFIED' || s === 'PENDING');
	return { governed, hasClient: !!client, hasProvider: !!provider };
}

export class LegalNameService {
	async getView(userId: string): Promise<LegalNameView> {
		const user = await prisma.user.findUnique({ where: { id: userId }, select: { legalName: true } });
		if (!user) throw new AppError('تعذر العثور على حساب المستخدم', 404);
		const [state, pending] = await Promise.all([
			identityState(userId),
			prisma.profileModificationRequest.findFirst({ where: { providerId: userId, category: LEGAL_NAME_CHANGE_REQUEST_CATEGORY, status: 'PENDING_HUMAN_REVIEW' }, orderBy: { createdAt: 'desc' }, select: { id: true, requestedValue: true, createdAt: true } })
		]);
		return {
			status: user.legalName ? 'PROVIDED' : 'MISSING',
			legalName: user.legalName ?? null,
			changeNeedsReview: !!user.legalName && state.governed,
			pendingRequest: pending ? { id: pending.id, requestedValue: pending.requestedValue, createdAt: pending.createdAt.toISOString() } : null
		};
	}

	/** Sets the legal name of the signed-in user. Returns what happened so the page can say it honestly. */
	async set(userId: string, raw: unknown, context?: AuditContext): Promise<{ outcome: 'SAVED' | 'UNCHANGED' | 'REQUEST_CREATED'; view: LegalNameView }> {
		const check = checkLegalName(raw);
		if (!check.ok) throw new AppError(check.message, 400, undefined, check.code);
		const user = await prisma.user.findUnique({ where: { id: userId }, select: { legalName: true } });
		if (!user) throw new AppError('تعذر العثور على حساب المستخدم', 404);
		if (user.legalName && check.value === user.legalName) return { outcome: 'UNCHANGED', view: await this.getView(userId) };
		const state = await identityState(userId);

		if (user.legalName && state.governed) {
			// a name tied to an identity that is verified or being verified: a request, never a direct write (and the name is not compared as "same" by approximation)
			if (sameLegalName(check.value, user.legalName)) throw new AppError('لا توجد تغييرات للحفظ', 400);
			const created = await prisma.$transaction(async (tx) => {
				await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`legalname:${userId}`}))`;
				const existing = await tx.profileModificationRequest.findFirst({ where: { providerId: userId, category: LEGAL_NAME_CHANGE_REQUEST_CATEGORY, status: 'PENDING_HUMAN_REVIEW' }, select: { id: true } });
				if (existing) throw new AppError('لديك طلب تعديل للاسم الحقيقي قيد المراجعة بالفعل', 409);
				return tx.profileModificationRequest.create({
					data: {
						providerId: userId, category: LEGAL_NAME_CHANGE_REQUEST_CATEGORY, fieldName: 'LEGAL_NAME', fieldLabel: 'الاسم الحقيقي (كما في الهوية)',
						currentValue: user.legalName, requestedValue: check.value, status: 'PENDING_HUMAN_REVIEW', requiresOtp: false,
						metadata: { changes: { legalName: check.value }, requiresHumanReview: true } as Prisma.InputJsonValue
					},
					select: { id: true }
				});
			});
			await accountAuditLogService.record({ userId, eventType: 'LEGAL_NAME_CHANGE_REQUESTED', category: 'PROFILE_COMPLETION', title: 'طلب تعديل الاسم الحقيقي', summary: 'أُرسل طلب تعديل الاسم الحقيقي للمراجعة؛ ستُعاد مطابقة الهوية بعد القرار', source: 'USER', severity: 'INFO', status: 'IN_REVIEW', requestId: created.id, context }).catch(e => logger.warn(`[LegalName] audit failed: ${(e as Error).message}`));
			return { outcome: 'REQUEST_CREATED', view: await this.getView(userId) };
		}

		await prisma.user.update({ where: { id: userId }, data: { legalName: check.value } });
		for (const party of parties(state)) identityFieldCheckService.triggerSafe(userId, party);
		await accountAuditLogService.record({ userId, eventType: 'LEGAL_NAME_SAVED', category: 'PROFILE_COMPLETION', title: 'الاسم الحقيقي', summary: user.legalName ? 'عُدّل الاسم الحقيقي قبل اعتماد الهوية' : 'أُضيف الاسم الحقيقي لمطابقته مع وثيقة الهوية', source: 'USER', severity: 'INFO', context }).catch(e => logger.warn(`[LegalName] audit failed: ${(e as Error).message}`));
		return { outcome: 'SAVED', view: await this.getView(userId) };
	}

	/** An admin approved a LEGAL_NAME_CHANGE request: the name is replaced and every verified identity goes back to PENDING (the document must be checked against the NEW name). */
	async applyApproved(userId: string, changes: Record<string, unknown>): Promise<void> {
		const check = checkLegalName(changes.legalName);
		if (!check.ok) throw new Error('INVALID_LEGAL_NAME');
		await prisma.$transaction(async (tx) => {
			await tx.user.update({ where: { id: userId }, data: { legalName: check.value } });
			await tx.clientProfile.updateMany({ where: { userId, kycStatus: 'VERIFIED' }, data: { kycStatus: 'PENDING' } });
			await tx.providerProfile.updateMany({ where: { userId, kycStatus: 'VERIFIED' }, data: { kycStatus: 'PENDING', isVerified: false } });
		});
		const state = await identityState(userId);
		for (const party of parties(state)) identityFieldCheckService.triggerSafe(userId, party);
	}
}

export const legalNameService = new LegalNameService();
