import { AccreditationStatus, SpecialtyVerificationStatus } from '@prisma/client';
import { prisma } from '../config/db';
import { AppError } from '../utils/app-error';
import { proofRequirements, uploadsOfSample } from './accreditation-proof.service';

// Batch B T1 (§4): the provider's «إجراءات الحساب» log. One row per approval request (AccreditationSample): id, specialty, model, attachments, dates and the REAL status.
// What the provider receives is a whitelist: the admin's note ADDRESSED to the provider (userNote) is returned, the internal note (internalNote) never is.

export type ApprovalRequestStatus = 'UNDER_REVIEW' | 'COMPLETION_REQUIRED' | 'REJECTED' | 'APPROVED';

export const REQUEST_STATUS_LABELS: Record<ApprovalRequestStatus, string> = {
	UNDER_REVIEW: 'قيد المراجعة',
	COMPLETION_REQUIRED: 'مطلوب استكمال البيانات',
	REJECTED: 'مرفوض',
	APPROVED: 'معتمد'
};
const EVENT_LABELS: Record<string, string> = {
	SUBMITTED: 'تم إرسال الطلب للمراجعة',
	RESUBMITTED: 'تمت إعادة إرسال الطلب بعد الاستكمال',
	COMPLETION_REQUESTED: 'طلبت الإدارة استكمال البيانات',
	REJECTED: 'تم رفض الطلب',
	APPROVED: 'تم اعتماد الطلب'
};
const REASON_MARKER = 'سبب الرفض:';

/** The status of a request as the provider sees it. `AI_VERIFIED` counts as approved only once the specialty itself is APPROVED. */
export function requestStatusOf(sample: { status: AccreditationStatus }, specialtyStatus?: string | null): ApprovalRequestStatus {
	switch (sample.status) {
		case AccreditationStatus.NEEDS_COMPLETION: return 'COMPLETION_REQUIRED';
		case AccreditationStatus.REJECTED: return 'REJECTED';
		case AccreditationStatus.AI_VERIFIED: return specialtyStatus === SpecialtyVerificationStatus.APPROVED ? 'APPROVED' : 'UNDER_REVIEW';
		default: return 'UNDER_REVIEW';
	}
}

const reasonFromFeedback = (feedback?: string | null) => {
	if (!feedback) return null;
	const i = feedback.lastIndexOf(REASON_MARKER);
	return i < 0 ? null : feedback.slice(i + REASON_MARKER.length).trim() || null;
};

export const shortRequestNo = (id: string) => `REQ-${id.replace(/-/g, '').slice(0, 8).toUpperCase()}`;

const sampleSelect = {
	id: true, title: true, description: true, technologiesUsed: true, projectUrl: true, githubUrl: true, status: true, aiFeedbackAr: true,
	userNote: true, completionFields: true, revision: true, decidedAt: true, createdAt: true, updatedAt: true, providerSpecialtyId: true,
	providerSpecialty: { select: { id: true, specialtyId: true, status: true, subSpecialties: true, specialty: { select: { nameAr: true, name: true } } } },
	serviceCatalogs: { select: { id: true, status: true } },
	// internalNote is deliberately NOT selected; events select only the user-facing note
	events: { orderBy: { createdAt: 'asc' as const }, select: { id: true, kind: true, revision: true, userNote: true, createdAt: true } }
} as const;

type Row = Awaited<ReturnType<typeof loadRows>>[number];
const loadRows = (userId: string, id?: string) => prisma.accreditationSample.findMany({
	where: { providerProfile: { userId }, ...(id ? { id } : {}) },
	orderBy: { createdAt: 'desc' },
	select: sampleSelect
});

async function shape(row: Row) {
	const status = requestStatusOf(row, row.providerSpecialty?.status);
	const attachments = await uploadsOfSample(prisma, row.id);
	return {
		id: row.id,
		requestNo: shortRequestNo(row.id),
		status,
		statusLabel: REQUEST_STATUS_LABELS[status],
		specialty: { providerSpecialtyId: row.providerSpecialtyId, specialtyId: row.providerSpecialty?.specialtyId ?? null, nameAr: row.providerSpecialty?.specialty?.nameAr || row.providerSpecialty?.specialty?.name || '', subSpecialties: row.providerSpecialty?.subSpecialties ?? [] },
		model: { title: row.title, description: row.description, technologiesUsed: row.technologiesUsed, projectUrl: row.projectUrl, githubUrl: row.githubUrl },
		attachments,
		allowedAttachments: proofRequirements(),
		revision: row.revision,
		// the admin's note to the provider; for a rejection the reason (note first, the legacy marker second)
		adminNote: status === 'COMPLETION_REQUIRED' || status === 'REJECTED' ? (row.userNote || reasonFromFeedback(row.aiFeedbackAr)) : (row.userNote || null),
		rejectionReason: status === 'REJECTED' ? (row.userNote || reasonFromFeedback(row.aiFeedbackAr)) : null,
		completionFields: status === 'COMPLETION_REQUIRED' ? row.completionFields : [],
		canResubmit: status === 'COMPLETION_REQUIRED' || status === 'REJECTED',
		linkedServices: row.serviceCatalogs?.length ?? 0,
		submittedAt: row.createdAt,
		updatedAt: row.updatedAt,
		decidedAt: row.decidedAt,
		history: row.events.map(e => ({ id: e.id, kind: e.kind, label: EVENT_LABELS[e.kind] ?? e.kind, revision: e.revision, note: e.userNote, at: e.createdAt }))
	};
}

export const approvalRequestService = {
	async list(userId: string) {
		const rows = await loadRows(userId);
		const items = await Promise.all(rows.map(shape));
		return { items, counts: { total: items.length, underReview: items.filter(i => i.status === 'UNDER_REVIEW').length, completionRequired: items.filter(i => i.status === 'COMPLETION_REQUIRED').length, rejected: items.filter(i => i.status === 'REJECTED').length, approved: items.filter(i => i.status === 'APPROVED').length } };
	},

	/** Only the owner reads a request; anyone else gets the same 404 as a missing id (no existence leak). */
	async get(userId: string, id: string) {
		const [row] = await loadRows(userId, id);
		if (!row) throw new AppError('الطلب غير موجود', 404);
		return shape(row);
	},

	/** The data the «استكمال البيانات» form opens with: the previous content + the fields to fix + the attached documents. */
	async getForCompletion(userId: string, id: string) {
		const item = await this.get(userId, id);
		if (!item.canResubmit) throw new AppError('لا يمكن استكمال هذا الطلب في حالته الحالية', 409);
		return item;
	}
};
