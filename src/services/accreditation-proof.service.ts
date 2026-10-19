import { ProofFileType, ProofUploadStatus } from '@prisma/client';
import { prisma } from '../config/db';
import { AppError } from '../utils/app-error';
import { privateFileExists } from '../utils/cloudinary-storage';
import { isPrivateRef, parsePrivateRef } from '../utils/kyc-private-ref';

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

/** The storage probe is swappable so tests run without Cloudinary; production uses the Cloudinary Admin API stat check. */
export const proofStorage: { exists: (ref: string) => Promise<boolean> } = {
	exists: ref => privateFileExists(ref)
};

const UNVERIFIED_MESSAGE = 'أحد ملفات الإثبات غير صالح أو لا يخص هذا الطلب؛ أعد رفعه';
const SEGMENT = /^[A-Za-z0-9_-]+$/;

/**
 * Is `ref` a proof document this user may rely on for THIS provider specialty? Verified, in this order, never from the string shape alone:
 *  1. SHAPE: a parsed private reference (never a URL / data URI / foreign string) under  waseetai/specialties/<specialty>/proofs/<file>
 *     or the owner's accreditation folder  waseetai/accreditation/<userId>/proofs/<file>.
 *  2. OWNERSHIP: specialty folder -> the specialty is the caller's own; accreditation folder -> the caller's own id.
 *  3. REGISTRY STATE: if the server registered the file (AccreditationProofUpload by this exact ref), the row must be the caller's, for this specialty and
 *     COMPLETED (UPLOADING / FAILED / CANCELLED or someone else's row refuses it). A ref that sits in another specialty's attachments is refused.
 *     A ref in the accreditation folder must be backed by such a COMPLETED row (that folder is per user, not per request).
 *  4. EXISTENCE: the object really exists in the storage (stat check).
 * LEGACY: a file the server stored in the specialty's own folder before upload rows existed (no AccreditationProofUpload row) passes on 1+2+3+4.
 */
export async function verifyStoredProofRef(db: Db, input: { userId: string; providerSpecialtyId: string; ref: string }): Promise<boolean> {
	const { userId, ref } = input;
	if (!isPrivateRef(ref)) return false;
	const parsed = parsePrivateRef(ref);
	if (!parsed) return false;
	const seg = parsed.publicId.split('/');
	if (seg.length < 5 || seg[0] !== 'waseetai' || seg[3] !== 'proofs' || !seg.every(x => SEGMENT.test(x))) return false;
	const ps = await db.providerSpecialty.findFirst({ where: { OR: [{ id: input.providerSpecialtyId }, { specialtyId: input.providerSpecialtyId }], providerProfile: { userId } }, select: { id: true } });
	if (!ps) return false;
	const inSpecialtyFolder = seg[1] === 'specialties' && (seg[2] === ps.id || seg[2] === input.providerSpecialtyId);
	const inOwnAccreditationFolder = seg[1] === 'accreditation' && seg[2] === userId;
	if (!inSpecialtyFolder && !inOwnAccreditationFolder) return false;
	const rows = await db.accreditationProofUpload.findMany({ where: { privateRef: ref }, select: { userId: true, providerSpecialtyId: true, status: true } });
	if (rows.some(r => r.userId !== userId || r.providerSpecialtyId !== ps.id || r.status !== ProofUploadStatus.COMPLETED)) return false;
	if (inOwnAccreditationFolder && rows.length === 0) return false;
	const elsewhere = await db.proofAttachment.count({ where: { fileUrl: ref, workSample: { providerSpecialtyId: { not: ps.id } } } });
	if (elsewhere > 0) return false;
	return proofStorage.exists(ref);
}

/**
 * The older multi-sample submit paths (POST /provider-specialty/submit-proof, POST /provider/specialties/step2-upload) store their proofs in the
 * specialty's own private folder and move the specialty to review. They obey the same rule as the main path: at least PROOF_MIN_FILES valid, completed,
 * owned proof documents, VERIFIED through verifyStoredProofRef (existence in storage, ownership, registry state). Documents the user already has as COMPLETED
 * uploads of this request (an edit) count too, each re-verified against storage. Anything else named is refused. This runs BEFORE any write.
 */
export async function assertLegacySpecialtyProofs(db: Db, input: { userId: string; providerSpecialtyId: string; proofRefs: unknown[] }) {
	const refs = [...new Set(input.proofRefs.filter((r): r is string => typeof r === 'string' && r.length > 0))];
	const base = { userId: input.userId, providerSpecialtyId: input.providerSpecialtyId };
	for (const ref of refs) {
		if (!(await verifyStoredProofRef(db, { ...base, ref }))) throw fieldError('files', UNVERIFIED_MESSAGE);
	}
	if (refs.length >= PROOF_MIN_FILES) return { fresh: refs.length, existing: 0 };
	const ps = await db.providerSpecialty.findFirst({ where: { OR: [{ id: input.providerSpecialtyId }, { specialtyId: input.providerSpecialtyId }], providerProfile: { userId: input.userId } }, select: { id: true } });
	const rows = ps ? await db.accreditationProofUpload.findMany({ where: { userId: input.userId, providerSpecialtyId: ps.id, status: ProofUploadStatus.COMPLETED }, select: { privateRef: true } }) : [];
	let existing = 0;
	for (const row of rows) if (await verifyStoredProofRef(db, { ...base, ref: row.privateRef })) existing += 1;
	if (existing < PROOF_MIN_FILES) throw fieldError('files', PROOF_REQUIRED_MESSAGE);
	return { fresh: 0, existing };
}

// ---------------------------------------------------------------------------------------------------------------------------------------------
// Admin review: ONE documented list of the proofs of a sample, covering BOTH storage shapes.
//   UPLOAD          AccreditationProofUpload row (Batch B mechanism): private, opened through POST /api/kyc-documents/access-link {document:'accreditation_upload', id}
//   LEGACY_PRIVATE  a private reference sitting in AccreditationSample.attachments with no upload row: access-link {document:'accreditation_sample_attachment', id: sampleId, index}
//   LEGACY_URL      an old public http(s) URL (Cloudinary etc.): `url` is returned as is and opened directly
//   LEGACY_INLINE   anything else stored in attachments (data: URI, bare file name): shown by name, cannot be opened
// A private reference is NEVER put in the response (the scrub middleware would turn it into null: that was the `attachments:[null]` defect), only the
// way to ask for a short-lived link. `available` is the result of a storage stat check: true / false (the file is missing) / null (unknown or not applicable).
// ---------------------------------------------------------------------------------------------------------------------------------------------
export type AdminProofSource = 'UPLOAD' | 'LEGACY_PRIVATE' | 'LEGACY_URL' | 'LEGACY_INLINE';
export interface AdminProofItem {
	key: string;
	source: AdminProofSource;
	id: string | null;
	fileName: string;
	mimeType: string | null;
	bytes: number | null;
	createdAt: string | null;
	url: string | null;
	access: { document: 'accreditation_upload'; id: string } | { document: 'accreditation_sample_attachment'; id: string; index: number } | null;
	available: boolean | null;
}

const EXISTS_TIMEOUT_MS = 5000;
async function probe(ref: string): Promise<boolean | null> {
	try {
		return await Promise.race([proofStorage.exists(ref), new Promise<null>(resolve => setTimeout(() => resolve(null), EXISTS_TIMEOUT_MS).unref?.())]);
	} catch { return null; }
}

const safeDecode = (v: string) => { try { return decodeURIComponent(v); } catch { return v; } };
const MIME_BY_EXT: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif', pdf: 'application/pdf', zip: 'application/zip' };
const mimeFromName = (name: string) => MIME_BY_EXT[(name.split('.').pop() || '').toLowerCase()] ?? null;

export async function buildAdminProofList(sample: { id: string; attachments?: unknown; proofUploads?: { id: string; privateRef: string; fileName: string; mimeType: string; bytes: number; createdAt: Date }[] | null }): Promise<AdminProofItem[]> {
	const uploads = Array.isArray(sample.proofUploads) ? sample.proofUploads : [];
	const attachments = Array.isArray(sample.attachments) ? sample.attachments : [];
	const covered = new Set(uploads.map(u => u.privateRef));
	const items: AdminProofItem[] = [];
	for (const u of uploads) {
		items.push({ key: `u:${u.id}`, source: 'UPLOAD', id: u.id, fileName: u.fileName || 'ملف إثبات', mimeType: u.mimeType || null, bytes: u.bytes ?? null, createdAt: u.createdAt ? new Date(u.createdAt).toISOString() : null, url: null, access: { document: 'accreditation_upload', id: u.id }, available: null });
	}
	attachments.forEach((raw, index) => {
		if (typeof raw !== 'string' || !raw.trim()) return; // never an entry for null / empty values
		if (isPrivateRef(raw)) {
			if (covered.has(raw)) return; // already listed as an UPLOAD
			const parsed = parsePrivateRef(raw);
			const base = parsed?.publicId.split('/').pop() || `مرفق-${index + 1}`;
			const fileName = parsed?.format ? `${base}.${parsed.format}` : base;
			items.push({ key: `a:${index}`, source: 'LEGACY_PRIVATE', id: null, fileName, mimeType: mimeFromName(fileName), bytes: null, createdAt: null, url: null, access: parsed ? { document: 'accreditation_sample_attachment', id: sample.id, index } : null, available: null });
		} else if (/^https?:\/\//i.test(raw)) {
			const name = safeDecode((raw.split('?')[0].split('#')[0].split('/').pop() || '').trim()) || `مرفق-${index + 1}`;
			items.push({ key: `a:${index}`, source: 'LEGACY_URL', id: null, fileName: name, mimeType: mimeFromName(name), bytes: null, createdAt: null, url: raw, access: null, available: null });
		} else if (raw.startsWith('data:')) {
			const m = /^data:([a-z0-9.+-]+\/[a-z0-9.+-]+)[;,]/i.exec(raw);
			items.push({ key: `a:${index}`, source: 'LEGACY_INLINE', id: null, fileName: `مرفق-${index + 1}`, mimeType: m ? m[1].toLowerCase() : null, bytes: null, createdAt: null, url: null, access: null, available: null });
		} else {
			items.push({ key: `a:${index}`, source: 'LEGACY_INLINE', id: null, fileName: safeDecode(raw.split('/').pop() || '').slice(0, 120) || `مرفق-${index + 1}`, mimeType: null, bytes: null, createdAt: null, url: null, access: null, available: null });
		}
	});
	// storage existence of the private files (bounded: at most PROOF_MAX_FILES uploads + legacy private refs, each probe has a timeout and never throws)
	const refOf = new Map<string, string>();
	uploads.forEach(u => refOf.set(`u:${u.id}`, u.privateRef));
	attachments.forEach((raw, index) => { if (typeof raw === 'string' && isPrivateRef(raw) && !covered.has(raw)) refOf.set(`a:${index}`, raw); });
	await Promise.all(items.map(async item => { const ref = refOf.get(item.key); if (ref) item.available = await probe(ref); }));
	return items;
}

/** The legacy `attachments` field of the admin detail: public http(s) links only, so it can never hold a null / private reference / inline data. */
export const publicLegacyAttachments = (attachments: unknown): string[] =>
	(Array.isArray(attachments) ? attachments : []).filter((a): a is string => typeof a === 'string' && /^https?:\/\//i.test(a));
