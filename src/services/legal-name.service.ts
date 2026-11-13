import { Prisma } from '@prisma/client';
import { prisma } from '../config/db';
import { AppError } from '../utils/app-error';
import { logger } from '../config/logger';
import { checkLegalName, sameLegalName } from '../utils/legal-name';
import { LEGAL_NAME_CHANGE_REQUEST_CATEGORY } from '../utils/profile-request-categories';
import { identityFieldCheckService } from './identity-field-check.service';
import { identityGateService } from './identity-gate.service';
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

const lockProfiles = async (tx: Prisma.TransactionClient, userId: string) => {
	// the SAME row locks an identity approval takes: a name change and an approval never interleave (lock order: client row, provider row, then users)
	await tx.$queryRaw`SELECT 1 FROM client_profiles WHERE "userId" = ${userId} FOR UPDATE`;
	await tx.$queryRaw`SELECT 1 FROM provider_profiles WHERE "userId" = ${userId} FOR UPDATE`;
};
async function identityState(userId: string, db: Prisma.TransactionClient | typeof prisma = prisma) {
	const [client, provider] = await Promise.all([
		db.clientProfile.findUnique({ where: { userId }, select: { kycStatus: true } }),
		db.providerProfile.findUnique({ where: { userId }, select: { kycStatus: true } })
	]);
	const statuses = [client?.kycStatus, provider?.kycStatus];
	return { anyVerified: statuses.includes('VERIFIED'), anyVerifiedOrPending: statuses.some(s => s === 'VERIFIED' || s === 'PENDING'), hasClient: !!client, hasProvider: !!provider };
}
/**
 * When does a legal-name write need an admin? The name is evidence for an identity that has been (or is being) verified:
 *  - a name already on file: any VERIFIED or PENDING identity => request;
 *  - NO name on file (older account): a VERIFIED account is verified for the name it was verified under and must not gain a new, unreviewed name => request;
 *    a PENDING / UNVERIFIED / REJECTED one may add it directly (the review that is coming includes it, and approval requires it).
 */
export const nameWriteNeedsReview = (currentName: string | null, s: { anyVerified: boolean; anyVerifiedOrPending: boolean }) => (currentName ? s.anyVerifiedOrPending : s.anyVerified);

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
			changeNeedsReview: nameWriteNeedsReview(user.legalName ?? null, state),
			pendingRequest: pending ? { id: pending.id, requestedValue: pending.requestedValue, createdAt: pending.createdAt.toISOString() } : null
		};
	}

	/** Sets the legal name of the signed-in user. Everything (state read, decision, write) happens under the profile row locks. */
	async set(userId: string, raw: unknown, context?: AuditContext): Promise<{ outcome: 'SAVED' | 'UNCHANGED' | 'REQUEST_CREATED'; view: LegalNameView }> {
		const check = checkLegalName(raw);
		if (!check.ok) throw new AppError(check.message, 400, undefined, check.code);
		const done = await prisma.$transaction(async (tx) => {
			await lockProfiles(tx, userId);
			const user = await tx.user.findUnique({ where: { id: userId }, select: { legalName: true } });
			if (!user) throw new AppError('تعذر العثور على حساب المستخدم', 404);
			if (user.legalName && check.value === user.legalName) return { kind: 'UNCHANGED' as const, previous: user.legalName, state: await identityState(userId, tx) };
			const state = await identityState(userId, tx);
			if (nameWriteNeedsReview(user.legalName ?? null, state)) {
				if (user.legalName && sameLegalName(check.value, user.legalName)) throw new AppError('لا توجد تغييرات للحفظ', 400);
				await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`legalname:${userId}`}))`;
				const existing = await tx.profileModificationRequest.findFirst({ where: { providerId: userId, category: LEGAL_NAME_CHANGE_REQUEST_CATEGORY, status: 'PENDING_HUMAN_REVIEW' }, select: { id: true } });
				if (existing) throw new AppError('لديك طلب تعديل للاسم الحقيقي قيد المراجعة بالفعل', 409);
				const created = await tx.profileModificationRequest.create({
					data: {
						providerId: userId, category: LEGAL_NAME_CHANGE_REQUEST_CATEGORY, fieldName: 'LEGAL_NAME', fieldLabel: 'الاسم الحقيقي (كما في الهوية)',
						currentValue: user.legalName ?? null, requestedValue: check.value, status: 'PENDING_HUMAN_REVIEW', requiresOtp: false,
						metadata: { changes: { legalName: check.value }, requiresHumanReview: true } as Prisma.InputJsonValue
					},
					select: { id: true }
				});
				return { kind: 'REQUEST' as const, requestId: created.id, previous: user.legalName, state };
			}
			await tx.user.update({ where: { id: userId }, data: { legalName: check.value } });
			return { kind: 'SAVED' as const, previous: user.legalName, state };
		});
		if (done.kind === 'REQUEST') {
			await accountAuditLogService.record({ userId, eventType: 'LEGAL_NAME_CHANGE_REQUESTED', category: 'PROFILE_COMPLETION', title: 'طلب تعديل الاسم الحقيقي', summary: 'أُرسل طلب تعديل الاسم الحقيقي للمراجعة؛ ستُعاد مطابقة الهوية بعد القرار', source: 'USER', severity: 'INFO', status: 'IN_REVIEW', requestId: done.requestId, context }).catch(e => logger.warn(`[LegalName] audit failed: ${(e as Error).message}`));
			return { outcome: 'REQUEST_CREATED', view: await this.getView(userId) };
		}
		if (done.kind === 'SAVED') {
			for (const party of parties(done.state)) identityFieldCheckService.triggerSafe(userId, party);
			await accountAuditLogService.record({ userId, eventType: 'LEGAL_NAME_SAVED', category: 'PROFILE_COMPLETION', title: 'الاسم الحقيقي', summary: done.previous ? 'عُدّل الاسم الحقيقي قبل اعتماد الهوية' : 'أُضيف الاسم الحقيقي لمطابقته مع وثيقة الهوية', source: 'USER', severity: 'INFO', context }).catch(e => logger.warn(`[LegalName] audit failed: ${(e as Error).message}`));
			return { outcome: 'SAVED', view: await this.getView(userId) };
		}
		return { outcome: 'UNCHANGED', view: await this.getView(userId) };
	}

	/** Apply the identity evidence change inside the caller's transaction, after taking the shared profile locks. */
	private async applyOn(tx: Prisma.TransactionClient, userId: string, changes: Record<string, unknown>) {
		const check = checkLegalName(changes.legalName);
		if (!check.ok) throw new Error('INVALID_LEGAL_NAME');
		await tx.user.update({ where: { id: userId }, data: { legalName: check.value } });
		const client = await tx.clientProfile.findUnique({ where: { userId }, select: { kycStatus: true, frontIdUrl: true } });
		if (client?.kycStatus === 'VERIFIED') {
			await tx.clientProfile.update({ where: { userId }, data: { kycStatus: 'PENDING', identityApprovedDigest: null } });
			if (client.frontIdUrl) await identityGateService.refreshClientReview(tx, userId, client.frontIdUrl);
		}
		await tx.providerProfile.updateMany({ where: { userId, kycStatus: 'VERIFIED' }, data: { kycStatus: 'PENDING', identityApprovedDigest: null, isVerified: false } });
		return identityState(userId, tx);
	}

	/** Compatibility entry for internal callers; request decisions use reviewRequest so the decision commits with the evidence. */
	async applyApproved(userId: string, changes: Record<string, unknown>): Promise<void> {
		const state = await prisma.$transaction(async tx => {
			await lockProfiles(tx, userId);
			return this.applyOn(tx, userId, changes);
		}, { timeout: 20_000 });
		for (const party of parties(state)) identityFieldCheckService.triggerSafe(userId, party);
	}

	/** Claim, name, KYC status and reopened review either all commit or all roll back. No external work before commit. */
	async reviewRequest(requestId: string, userId: string, approved: boolean, reason: string | null, context?: AuditContext) {
		const result = await prisma.$transaction(async tx => {
			await lockProfiles(tx, userId);
			const request = await tx.profileModificationRequest.findUnique({ where: { id: requestId } });
			if (!request || request.providerId !== userId || request.category !== LEGAL_NAME_CHANGE_REQUEST_CATEGORY) throw new Error('REQUEST_NOT_FOUND');
			const claimed = await tx.profileModificationRequest.updateMany({
				where: { id: requestId, status: 'PENDING_HUMAN_REVIEW' },
				data: { status: approved ? 'APPROVED' : 'REJECTED', reviewedByAdmin: true, rejectionReason: reason, appliedAt: approved ? new Date() : null }
			});
			if (!claimed.count) throw new Error('REQUEST_NOT_PENDING_REVIEW');
			const changes = (request.metadata as { changes?: Record<string, unknown> } | null)?.changes ?? {};
			const state = approved ? await this.applyOn(tx, userId, changes) : null;
			return { row: await tx.profileModificationRequest.findUniqueOrThrow({ where: { id: requestId } }), state };
		}, { timeout: 20_000 });
		if (result.state) for (const party of parties(result.state)) identityFieldCheckService.triggerSafe(userId, party);
		await accountAuditLogService.record({ userId, eventType: 'HUMAN_REVIEW_COMPLETED', category: 'PROFILE_COMPLETION', title: result.row.fieldLabel, summary: approved ? 'اعتمد المراجع طلب تعديل الاسم الحقيقي وأعاد الهوية للمراجعة' : 'رفض المراجع طلب تعديل الاسم الحقيقي', source: 'ADMIN', severity: approved ? 'INFO' : 'WARNING', status: approved ? 'APPROVED' : 'REJECTED', statusText: reason ?? undefined, requestId, context }).catch(e => logger.warn(`[LegalName] post-commit audit failed: ${(e as Error).message}`));
		return result.row;
	}
}

export const legalNameService = new LegalNameService();
