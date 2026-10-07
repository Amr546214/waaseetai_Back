import { AccountType, LogCategory, UserRole } from '@prisma/client';
import { prisma } from '../config/db';
import { AppError } from '../utils/app-error';
import { createPrivateDownloadUrl } from '../utils/cloudinary-storage';
import { isOwnCloudinaryUrl } from '../utils/cloudinary-url';
import { isPrivateRef } from '../utils/kyc-private-ref';
import { accountAuditLogService, AuditContext } from './account-logs.service';

export const KYC_DOCUMENT_KEYS = [
	'client_front_id', 'client_back_id', 'client_supporting_docs',
	'provider_front_id', 'provider_back_id', 'provider_supporting_docs', 'provider_certificate',
	'onboarding_document', 'user_id_document', 'user_vat_certificate',
	'specialty_proof', 'accreditation_proof'
] as const;
export type KycDocumentKey = (typeof KYC_DOCUMENT_KEYS)[number];

export interface KycAccessInput { document: KycDocumentKey; userId?: string; id?: string; index?: number }
export interface Requester { id: string; accountType: AccountType; activeRole?: UserRole | null; roles?: UserRole[] }
export interface KycAccessLink { url: string; expiresAt: string | null; expiresInSeconds: number | null; private: boolean; legacy: boolean }

export function isAdminRequester(r: Requester): boolean {
	if (r.accountType === AccountType.ADMIN || r.accountType === AccountType.SUPER_ADMIN) return true;
	const roles = new Set<UserRole>(r.roles || []);
	if (r.activeRole) roles.add(r.activeRole);
	return roles.has(UserRole.ADMIN) || roles.has(UserRole.SUPER_ADMIN);
}

export function linkTtlSeconds(): number {
	const raw = Number(process.env.KYC_ACCESS_LINK_TTL_SECONDS);
	return Number.isFinite(raw) && raw > 0 ? Math.min(600, Math.max(30, Math.floor(raw))) : 120;
}

const NOT_FOUND = () => new AppError('لا توجد وثيقة مرفوعة لهذا الحقل', 404);
const FORBIDDEN = () => new AppError('غير مصرح لك بالوصول إلى هذه الوثيقة', 403);

interface Resolved { ownerUserId: string; stored: string | null }

async function resolve(input: KycAccessInput, target: string): Promise<Resolved> {
	switch (input.document) {
		case 'client_front_id': case 'client_back_id': case 'client_supporting_docs': {
			const row = await prisma.clientProfile.findUnique({ where: { userId: target }, select: { frontIdUrl: true, backIdUrl: true, supportingDocsUrl: true } });
			const stored = input.document === 'client_front_id' ? row?.frontIdUrl : input.document === 'client_back_id' ? row?.backIdUrl : row?.supportingDocsUrl;
			return { ownerUserId: target, stored: stored ?? null };
		}
		case 'provider_front_id': case 'provider_back_id': case 'provider_supporting_docs': case 'provider_certificate': {
			const row = await prisma.providerProfile.findUnique({ where: { userId: target }, select: { frontIdUrl: true, backIdUrl: true, supportingDocsUrl: true, certUrls: true } });
			const stored = input.document === 'provider_front_id' ? row?.frontIdUrl
				: input.document === 'provider_back_id' ? row?.backIdUrl
				: input.document === 'provider_supporting_docs' ? row?.supportingDocsUrl
				: row?.certUrls?.[input.index ?? 0];
			return { ownerUserId: target, stored: stored ?? null };
		}
		case 'onboarding_document': {
			const row = input.id
				? await prisma.clientOnboarding.findUnique({ where: { id: input.id }, select: { userId: true, documentUrl: true } })
				: await prisma.clientOnboarding.findUnique({ where: { userId: target }, select: { userId: true, documentUrl: true } });
			if (!row) throw NOT_FOUND();
			return { ownerUserId: row.userId, stored: row.documentUrl ?? null };
		}
		case 'user_id_document': case 'user_vat_certificate': {
			const row = await prisma.user.findUnique({ where: { id: target }, select: { idDocumentUrl: true, vatCertificateUrl: true } });
			return { ownerUserId: target, stored: (input.document === 'user_id_document' ? row?.idDocumentUrl : row?.vatCertificateUrl) ?? null };
		}
		case 'specialty_proof': {
			if (!input.id) throw new AppError('معرّف الملف مطلوب', 400);
			const row = await prisma.proofAttachment.findUnique({ where: { id: input.id }, select: { fileUrl: true, workSample: { select: { providerSpecialty: { select: { providerProfile: { select: { userId: true } } } } } } } });
			const owner = row?.workSample?.providerSpecialty?.providerProfile?.userId;
			if (!row || !owner) throw NOT_FOUND();
			return { ownerUserId: owner, stored: row.fileUrl };
		}
		case 'accreditation_proof': {
			if (!input.id) throw new AppError('معرّف الملف مطلوب', 400);
			const row = await prisma.accreditationProofFile.findUnique({ where: { id: input.id }, select: { fileUrl: true, submission: { select: { providerProfile: { select: { userId: true } } } } } });
			const owner = row?.submission?.providerProfile?.userId;
			if (!row || !owner) throw NOT_FOUND();
			return { ownerUserId: owner, stored: row.fileUrl };
		}
	}
}

/**
 * The only way to read a KYC document. The owner may open their own; an admin may open anyone's (and that access is written to the
 * target's audit log); everyone else is refused. Only an admin may pass `userId`.
 */
export async function createKycAccessLink(requester: Requester, input: KycAccessInput, context?: AuditContext): Promise<KycAccessLink> {
	const admin = isAdminRequester(requester);
	if (input.userId && !admin) throw FORBIDDEN();
	const idKeyed = input.document === 'specialty_proof' || input.document === 'accreditation_proof' || (input.document === 'onboarding_document' && !!input.id);
	if (admin && !input.userId && !idKeyed) throw new AppError('معرّف المستخدم مطلوب للمشرف', 400);
	const target = admin ? (input.userId as string) : requester.id;

	const { ownerUserId, stored } = await resolve(input, target);
	if (!admin && ownerUserId !== requester.id) throw FORBIDDEN();
	if (!stored) throw NOT_FOUND();

	let link: KycAccessLink;
	if (isPrivateRef(stored)) {
		const signed = createPrivateDownloadUrl(stored, linkTtlSeconds());
		if (!signed) throw NOT_FOUND();
		link = { url: signed.url, expiresAt: signed.expiresAt.toISOString(), expiresInSeconds: linkTtlSeconds(), private: true, legacy: false };
	} else if (isOwnCloudinaryUrl(stored)) {
		// Transition: a document uploaded before the private-storage change. It keeps working until the migration moves it.
		link = { url: stored, expiresAt: null, expiresInSeconds: null, private: false, legacy: true };
	} else {
		throw NOT_FOUND();
	}

	if (admin) {
		await accountAuditLogService.record({
			userId: ownerUserId,
			eventType: 'KYC_DOCUMENT_VIEWED_BY_ADMIN',
			category: LogCategory.SECURITY_CHANGE,
			title: 'اطّلاع المشرف على وثيقة هوية',
			summary: 'فتح مشرف وثيقة مرفوعة في الحساب عبر رابط مؤقت.',
			source: 'ADMIN',
			severity: 'INFO',
			details: { document: input.document, viewerUserId: requester.id },
			context
		});
	}
	return link;
}
