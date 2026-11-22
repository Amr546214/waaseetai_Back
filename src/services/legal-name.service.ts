import { identityClaimService } from './identity-claim.service';
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
 * The owner saves this value directly in every identity state. Saving cancels old
 * pending name-change requests and reruns identity matching. An approval for changed
 * evidence is invalidated in the SAME transaction; there is no name-approval request.
 */
export type LegalNameStatus = 'MISSING' | 'PROVIDED';
export interface LegalNameView { status: LegalNameStatus; legalName: string | null; changeNeedsReview: boolean; pendingRequest: { id: string; requestedValue: string | null; createdAt: string } | null }

const parties = (kinds: { hasClient: boolean; hasProvider: boolean }) => [...(kinds.hasClient ? ['CLIENT' as const] : []), ...(kinds.hasProvider ? ['PROVIDER' as const] : [])];

const lockProfiles = async (tx: Prisma.TransactionClient, userId: string) => {
	// the SAME row locks an identity approval takes: a name change and an approval never interleave (lock order: client row, provider row, then users)
	await tx.$queryRaw`SELECT 1 FROM client_profiles WHERE "userId" = ${userId} FOR UPDATE`;
	await tx.$queryRaw`SELECT 1 FROM provider_profiles WHERE "userId" = ${userId} FOR UPDATE`;
	await tx.$queryRaw`SELECT 1 FROM users WHERE id = ${userId} FOR UPDATE`;
};
async function identityState(userId: string, db: Prisma.TransactionClient | typeof prisma = prisma) {
	const [client, provider] = await Promise.all([
		db.clientProfile.findUnique({ where: { userId }, select: { kycStatus: true } }),
		db.providerProfile.findUnique({ where: { userId }, select: { kycStatus: true } })
	]);
	const statuses = [client?.kycStatus, provider?.kycStatus];
	return { anyVerified: statuses.includes('VERIFIED'), anyVerifiedOrPending: statuses.some(s => s === 'VERIFIED' || s === 'PENDING'), hasClient: !!client, hasProvider: !!provider };
}
export class LegalNameService {
	async getView(userId: string): Promise<LegalNameView> {
		const user = await prisma.user.findUnique({ where: { id: userId }, select: { legalName: true } });
		if (!user) throw new AppError('تعذر العثور على حساب المستخدم', 404);
		const pending = await prisma.profileModificationRequest.findFirst({ where: { providerId: userId, category: LEGAL_NAME_CHANGE_REQUEST_CATEGORY, status: 'PENDING_HUMAN_REVIEW' }, orderBy: { createdAt: 'desc' }, select: { id: true, requestedValue: true, createdAt: true } });
		return {
			status: user.legalName ? 'PROVIDED' : 'MISSING',
			legalName: user.legalName ?? null,
			changeNeedsReview: false, // compatibility field: saving a legal name never creates an approval request
			pendingRequest: pending ? { id: pending.id, requestedValue: pending.requestedValue, createdAt: pending.createdAt.toISOString() } : null
		};
	}

	/** Direct owner save, serialised with identity approvals and legacy request decisions. */
	async set(userId: string, raw: unknown, context?: AuditContext): Promise<{ outcome: 'SAVED' | 'UNCHANGED'; view: LegalNameView }> {
		const check = checkLegalName(raw);
		if (!check.ok) throw new AppError(check.message, 400, undefined, check.code);
		const done = await prisma.$transaction(async (tx) => {
			await lockProfiles(tx, userId);
			const user = await tx.user.findUnique({ where: { id: userId }, select: { legalName: true } });
			if (!user) throw new AppError('تعذر العثور على حساب المستخدم', 404);
			// Old requests are history only after this save. A delayed reviewer cannot
			// overwrite the name the owner has just saved (reviewRequest takes these locks too).
			await tx.profileModificationRequest.updateMany({ where: { providerId: userId, category: LEGAL_NAME_CHANGE_REQUEST_CATEGORY, status: 'PENDING_HUMAN_REVIEW' }, data: { status: 'CANCELLED' } });
			if (check.value === user.legalName) return { kind: 'UNCHANGED' as const, state: await identityState(userId, tx) };
			// Case/diacritic-only corrections have the same identity digest; keep their approval.
			let state;
			if (user.legalName && sameLegalName(check.value, user.legalName)) {
				await tx.user.update({ where: { id: userId }, data: { legalName: check.value } });
				state = await identityState(userId, tx);
			} else state = await this.applyOn(tx, userId, { legalName: check.value });
			return { kind: 'SAVED' as const, state };
		}, { timeout: 20_000 });
		if (done.kind === 'SAVED') {
			for (const party of parties(done.state)) identityFieldCheckService.triggerSafe(userId, party);
			await accountAuditLogService.record({ userId, eventType: 'LEGAL_NAME_SAVED', category: 'PROFILE_COMPLETION', title: 'الاسم الحقيقي', summary: 'حُفظ الاسم الحقيقي مباشرة لتحديث مطابقته مع وثيقة الهوية', source: 'USER', severity: 'INFO', context }).catch(e => logger.warn(`[LegalName] audit failed: ${(e as Error).message}`));
		}
		return { outcome: done.kind, view: await this.getView(userId) };
	}

	/** The owner withdraws the name-change request that still waits for review (e.g. a typo): the current name stays. Kept for old clients during deployment. */
	async cancelPending(userId: string, context?: AuditContext) {
		const claimed = await prisma.profileModificationRequest.updateMany({ where: { providerId: userId, category: LEGAL_NAME_CHANGE_REQUEST_CATEGORY, status: 'PENDING_HUMAN_REVIEW' }, data: { status: 'CANCELLED' } });
		if (!claimed.count) throw new AppError('لا يوجد طلب تعديل للاسم قيد المراجعة', 404);
		await accountAuditLogService.record({ userId, eventType: 'LEGAL_NAME_REQUEST_CANCELLED', category: 'PROFILE_COMPLETION', title: 'سحب طلب تعديل الاسم الحقيقي', summary: 'سحب المستخدم طلب تعديل الاسم الحقيقي قبل المراجعة', source: 'USER', status: 'COMPLETED', ...(context ? { context } : {}) } as any);
		return { view: await this.getView(userId) };
	}

	/** Save changed identity evidence inside the caller's transaction, after taking the shared profile locks. */
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
		await identityClaimService.release(tx, userId, 'CLIENT'); // both approvals were cancelled: the account no longer holds an approved identity
		return identityState(userId, tx);
	}

	/** Compatibility for legacy internal callers. New owner saves use set() directly. */
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
