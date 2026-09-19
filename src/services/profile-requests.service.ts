import { prisma } from '../config/db';
import { ChangeRequestStatus, SensitiveFieldType, Prisma } from '@prisma/client';
import { AppError } from '../utils/app-error';

const PENDING_STATUSES: ChangeRequestStatus[] = [ChangeRequestStatus.PENDING_AI_REVIEW, ChangeRequestStatus.PENDING_HUMAN_APPROVAL];

export interface FieldChangeCandidate {
	fieldType: SensitiveFieldType;
	fieldLabel: string;
	currentValue: string | null;
	// undefined = this field was not part of the submitted request at all
	// (distinct from an empty string, which IS a real requested value).
	requestedValue: string | undefined;
}

/**
 * Shared "create a governed field-change request" helper — the single place
 * that (a) skips fields whose requested value is unchanged from the current
 * one, (b) rejects the whole batch if ANY of the changed fields already has
 * a pending (PENDING_AI_REVIEW/PENDING_HUMAN_APPROVAL) request, and (c)
 * creates one ProfileChangeRequest row per remaining changed field — used by
 * both the identity-fields flow below and marketer-profile.service.ts's
 * banking flow, so both share identical duplicate/no-op semantics instead of
 * two independently-hand-rolled versions.
 *
 * Must be called with a transaction client so the duplicate-check and the
 * creates are atomic with whatever else the caller is doing in the same
 * transaction (e.g. banking's direct-vs-governed field split).
 */
export async function createGovernedFieldRequests(
	tx: Prisma.TransactionClient,
	affiliateProfileId: string,
	candidates: FieldChangeCandidate[]
) {
	const changed = candidates.filter(c => c.requestedValue !== undefined && c.requestedValue !== (c.currentValue ?? ''));

	if (changed.length === 0) {
		throw new AppError('لم يتم إجراء أي تغيير على الحقول المطلوبة', 400);
	}

	const conflicts: FieldChangeCandidate[] = [];
	for (const candidate of changed) {
		const existing = await tx.profileChangeRequest.findFirst({
			where: { affiliateProfileId, fieldType: candidate.fieldType, status: { in: PENDING_STATUSES } }
		});
		if (existing) conflicts.push(candidate);
	}

	if (conflicts.length > 0) {
		throw new AppError(`يوجد طلب تعديل معلّق بالفعل لـ: ${conflicts.map(c => c.fieldLabel).join('، ')}`, 409);
	}

	const created = [];
	for (const candidate of changed) {
		const requestNumber = `REQ-${Math.floor(1000 + Math.random() * 9000)}`;
		created.push(await tx.profileChangeRequest.create({
			data: {
				requestNumber,
				affiliateProfileId,
				fieldType: candidate.fieldType,
				fieldLabel: candidate.fieldLabel,
				currentValue: candidate.currentValue || '',
				requestedValue: candidate.requestedValue as string,
				status: ChangeRequestStatus.PENDING_AI_REVIEW
			}
		}));
	}

	return created;
}

// EMAIL deliberately excluded — see profile-requests.dto.ts for why. Not just
// a DTO-layer restriction: this interface itself has no `email` field, so
// even a caller that bypasses the DTO (e.g. an internal call) cannot express
// an EMAIL change through this function at all.
export interface IdentityChangeInput {
	firstName?: string;
	lastName?: string;
	nationalId?: string;
	phoneNumber?: string;
}

export class ProfileRequestsService {
	public async getRequests(userId: string) {
		const profile = await prisma.affiliateProfile.findUnique({ where: { userId } });
		if (!profile) throw new Error('Affiliate profile not found');

		const requests = await prisma.profileChangeRequest.findMany({
			where: { affiliateProfileId: profile.id },
			orderBy: { createdAt: 'desc' },
		});

		const pendingAiCount = requests.filter(r => r.status === ChangeRequestStatus.PENDING_AI_REVIEW).length;
		const pendingHumanCount = requests.filter(r => r.status === ChangeRequestStatus.PENDING_HUMAN_APPROVAL).length;
		const approvedCount = requests.filter(r => r.status === ChangeRequestStatus.APPROVED_AND_APPLIED).length;
		const rejectedCount = requests.filter(r => r.status === ChangeRequestStatus.REJECTED).length;

		return {
			totalRequests: requests.length,
			pendingAiCount,
			pendingHumanCount,
			approvedCount,
			rejectedCount,
			items: requests,
		};
	}

	/**
	 * Governed identity-field change requests — FIRST_NAME/LAST_NAME/
	 * NATIONAL_ID/PHONE_NUMBER/EMAIL are all User columns (confirmed via
	 * marketer-profile.service.ts#getProfile's own `user: { select: {
	 * firstName, lastName, email, phoneNumber, idNumber } }` and the basics
	 * tab template reading `profile()?.user?.*`), not AffiliateProfile
	 * columns — unlike IBAN/banking, which live on AffiliateProfile itself.
	 * Note AffiliateProfile has its OWN separate firstName/lastName columns
	 * (the Phase 3A per-role display identity used by this same page's
	 * "الملف التسويقي" tab/avatar) — those are a distinct concept and are
	 * never read or written by this basics-tab flow. The request row's owner
	 * is still the caller's AffiliateProfile (the model is scoped to
	 * affiliateProfileId), same as every other ProfileChangeRequest.
	 *
	 * Never writes the real User row — only ever creates ProfileChangeRequest
	 * rows via the shared createGovernedFieldRequests helper, so the same
	 * duplicate-pending and unchanged-value rules apply here as everywhere
	 * else.
	 */
	public async createIdentityRequests(userId: string, changes: IdentityChangeInput) {
		return prisma.$transaction(async (tx) => {
			const profile = await tx.affiliateProfile.findUnique({ where: { userId } });
			if (!profile) throw new AppError('ملف الوسيط التسويقي غير موجود', 404);

			const user = await tx.user.findUnique({ where: { id: userId } });
			if (!user) throw new AppError('حساب المستخدم غير موجود', 404);

			const candidates: FieldChangeCandidate[] = [
				{ fieldType: SensitiveFieldType.FIRST_NAME, fieldLabel: 'الاسم الأول', currentValue: user.firstName, requestedValue: changes.firstName },
				{ fieldType: SensitiveFieldType.LAST_NAME, fieldLabel: 'اسم العائلة', currentValue: user.lastName, requestedValue: changes.lastName },
				{ fieldType: SensitiveFieldType.NATIONAL_ID, fieldLabel: 'رقم الهوية الوطنية', currentValue: user.idNumber, requestedValue: changes.nationalId },
				{ fieldType: SensitiveFieldType.PHONE_NUMBER, fieldLabel: 'رقم الجوال', currentValue: user.phoneNumber, requestedValue: changes.phoneNumber }
			];

			return createGovernedFieldRequests(tx, profile.id, candidates);
		});
	}

	public async withdrawRequest(userId: string, requestId: string) {
		const profile = await prisma.affiliateProfile.findUnique({ where: { userId } });
		if (!profile) throw new Error('Affiliate profile not found');

		const req = await prisma.profileChangeRequest.findUnique({
			where: { requestNumber: requestId },
		});

		if (!req) throw new Error('Request not found');
		if (req.affiliateProfileId !== profile.id) throw new Error('Unauthorized');

		if (req.status !== ChangeRequestStatus.PENDING_AI_REVIEW && req.status !== ChangeRequestStatus.PENDING_HUMAN_APPROVAL) {
			throw new Error('Can only withdraw pending requests');
		}

		const updated = await prisma.profileChangeRequest.update({
			where: { requestNumber: requestId },
			data: { status: ChangeRequestStatus.WITHDRAWN },
		});

		return updated;
	}
}

export const profileRequestsService = new ProfileRequestsService();
