import { ProofFileType, ProofUploadStatus } from '@prisma/client';
import { prisma } from '../config/db';
import { AppError } from '../utils/app-error';
import { isPrivateRef } from '../utils/kyc-private-ref';

// Batch B T1 (§3): proof documents of an approval request. A document counts only when it is a COMPLETED upload row that belongs to the SAME user
// AND to the SAME request (the provider specialty). A URL typed into the body, an upload still in progress, a failed or a cancelled one never counts.
// Identity documents (KYC) are a different function and live in their own store: they are never accepted here.

export const PROOF_ALLOWED_MIME_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'application/pdf', 'application/zip', 'application/x-zip-compressed'] as const;
export const PROOF_MAX_BYTES = 15 * 1024 * 1024;
export const PROOF_MAX_FILES = 10;
export const PROOF_MIN_FILES = 1;
export const PROOF_REQUIRED_MESSAGE = 'ارفع ملف إثبات واحدًا على الأقل لنموذج العمل (صورة أو PDF أو ملف مضغوط، حتى 15 ميجابايت)';

export const proofRequirements = () => ({
	field: 'files',
	label: 'ملفات إثبات نموذج العمل',
	minFiles: PROOF_MIN_FILES,
	maxFiles: PROOF_MAX_FILES,
	maxBytes: PROOF_MAX_BYTES,
	maxMegabytes: PROOF_MAX_BYTES / 1024 / 1024,
	allowedMimeTypes: [...PROOF_ALLOWED_MIME_TYPES],
	allowedExtensions: ['png', 'jpg', 'jpeg', 'webp', 'pdf', 'zip'],
	note: 'تُستخدم هذه الملفات لإثبات نموذج العمل لهذا التخصص فقط، ولا تغني عن وثائق الهوية.'
});

type Db = typeof prisma;

const fieldError = (field: string, message: string) => new AppError(message, 400, [{ path: field, field, message, code: 'required' }]);

export interface RegisterUploadInput {
	userId: string; providerSpecialtyId: string; privateRef: string; fileName: string; mimeType: string; bytes: number; kind?: ProofFileType;
}

/** The request this upload belongs to must be the caller's own provider specialty. */
export async function assertOwnSpecialty(db: Db, userId: string, providerSpecialtyId: string) {
	const ps = await db.providerSpecialty.findFirst({ where: { OR: [{ id: providerSpecialtyId }, { specialtyId: providerSpecialtyId }], providerProfile: { userId } }, select: { id: true, isActive: true } });
	if (!ps) throw new AppError('التخصص غير مرتبط بحساب مقدم الخدمة', 403);
	return ps;
}

export async function startUpload(db: Db, input: Omit<RegisterUploadInput, 'privateRef' | 'bytes'> & { bytes?: number }) {
	const ps = await assertOwnSpecialty(db, input.userId, input.providerSpecialtyId);
	return db.accreditationProofUpload.create({
		data: { userId: input.userId, providerSpecialtyId: ps.id, privateRef: 'pending', fileName: input.fileName, mimeType: input.mimeType, bytes: input.bytes ?? 0, kind: input.kind ?? ProofFileType.WORK_SAMPLE, status: ProofUploadStatus.UPLOADING }
	});
}
export const completeUpload = (db: Db, id: string, privateRef: string, bytes: number) =>
	db.accreditationProofUpload.update({ where: { id }, data: { privateRef, bytes, status: ProofUploadStatus.COMPLETED } });
export const failUpload = (db: Db, id: string) =>
	db.accreditationProofUpload.update({ where: { id }, data: { status: ProofUploadStatus.FAILED } }).catch(() => null);

/** What the client may see of an upload: never the private reference. */
export const publicUpload = (u: { id: string; fileName: string; mimeType: string; bytes: number; status: string; sampleId: string | null; createdAt: Date }) =>
	({ id: u.id, fileName: u.fileName, mimeType: u.mimeType, bytes: u.bytes, status: u.status, attached: !!u.sampleId, createdAt: u.createdAt });

export async function listUploads(db: Db, userId: string, providerSpecialtyId: string, sampleId?: string | null) {
	const ps = await assertOwnSpecialty(db, userId, providerSpecialtyId);
	const rows = await db.accreditationProofUpload.findMany({
		where: { userId, providerSpecialtyId: ps.id, status: ProofUploadStatus.COMPLETED, OR: [{ sampleId: null }, ...(sampleId ? [{ sampleId }] : [])] },
		orderBy: { createdAt: 'asc' }
	});
	return rows.map(publicUpload);
}

/**
 * Deleting a required document restores the "missing" state: the row is CANCELLED, so it no longer counts. A document that belongs to a request the
 * admin is still reviewing (or has approved) is not removable.
 */
export async function removeUpload(db: Db, userId: string, id: string) {
	const row = await db.accreditationProofUpload.findUnique({ where: { id }, include: { sample: { select: { status: true } } } });
	if (!row || row.userId !== userId) throw new AppError('الملف غير موجود', 404);
	if (row.status === ProofUploadStatus.CANCELLED) return { id, removed: true };
	if (row.sampleId && row.sample && row.sample.status !== 'NEEDS_COMPLETION' && row.sample.status !== 'REJECTED') {
		throw new AppError('لا يمكن حذف ملف مرتبط بطلب قيد المراجعة أو معتمد', 409);
	}
	await db.accreditationProofUpload.update({ where: { id }, data: { status: ProofUploadStatus.CANCELLED } });
	return { id, removed: true };
}

export interface ResolvedProofs { uploads: { id: string; privateRef: string; fileName: string }[]; urls: string[] }

/**
 * The proofs of a submission: `proofIds` (uploads made through upload-proof) and/or `attachmentRefs` (legacy body strings, accepted ONLY when they equal the
 * private reference of the caller's own COMPLETED upload for this request). Anything else is a 400 naming the field. At least PROOF_MIN_FILES valid
 * documents are required; `sampleId` lets a resubmission re-use the documents already attached to the same request.
 */
export async function resolveProofsForSubmission(db: Db, input: { userId: string; providerSpecialtyId: string; proofIds?: string[]; attachmentRefs?: string[]; sampleId?: string | null }): Promise<ResolvedProofs> {
	const ids = [...new Set((input.proofIds ?? []).filter(v => typeof v === 'string' && v))];
	const refs = [...new Set((input.attachmentRefs ?? []).filter(v => typeof v === 'string' && v))];
	const base = { userId: input.userId, providerSpecialtyId: input.providerSpecialtyId, status: ProofUploadStatus.COMPLETED, OR: [{ sampleId: null }, ...(input.sampleId ? [{ sampleId: input.sampleId }] : [])] };
	const wanted: any[] = [];
	if (ids.length) wanted.push({ id: { in: ids } });
	if (refs.length) wanted.push({ privateRef: { in: refs } });
	// a resubmission keeps the documents still attached to the same request (the ones the user removed are CANCELLED and do not match)
	if (input.sampleId) wanted.push({ sampleId: input.sampleId });
	const rows = wanted.length ? await db.accreditationProofUpload.findMany({ where: { ...base, AND: [{ OR: wanted }] } }) : [];
	// everything the caller named must have matched a valid upload: a foreign, in-progress, failed, cancelled or other-request document is refused
	const matchedIds = new Set(rows.map(r => r.id));
	const matchedRefs = new Set(rows.map(r => r.privateRef));
	if (ids.some(i => !matchedIds.has(i)) || refs.some(r => !matchedRefs.has(r))) {
		throw fieldError('files', 'أحد ملفات الإثبات غير صالح أو لم يكتمل رفعه أو لا يخص هذا الطلب؛ أعد رفعه');
	}
	if (rows.length < PROOF_MIN_FILES) throw fieldError('files', PROOF_REQUIRED_MESSAGE);
	if (rows.length > PROOF_MAX_FILES) throw fieldError('files', `الحد الأقصى ${PROOF_MAX_FILES} ملفات`);
	return { uploads: rows.map(r => ({ id: r.id, privateRef: r.privateRef, fileName: r.fileName })), urls: rows.map(r => r.privateRef).filter(isPrivateRef) };
}

/** Proof documents already attached to a request (for the resubmission screen and the request log): public shape only. */
export async function uploadsOfSample(db: Db, sampleId: string) {
	const rows = await db.accreditationProofUpload.findMany({ where: { sampleId, status: ProofUploadStatus.COMPLETED }, orderBy: { createdAt: 'asc' } });
	return rows.map(publicUpload);
}
