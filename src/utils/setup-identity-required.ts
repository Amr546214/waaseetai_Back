import { AppError } from './app-error';
import { isPrivateRef, privateRefBelongsTo } from './kyc-private-ref';
import { privateFileExists } from './cloudinary-storage';

// Provider setup, identity step: the FRONT of the ID is the required evidence (the back, the number and certificates are optional). It is satisfied ONLY by a real document
//  - already on file for this provider: the stored front, the approved ID document of the account, or the ID document of a DOCUMENTS change request that is waiting for the admin.
//    A private reference counts only when it belongs to the provider and EXISTS in the storage (stat); a legacy stored value (an older flow's file name / public URL) is trusted as
//    stored because it cannot be verified any other way; or
//  - a NEW front sent now: a data: URI of an allowed type or the caller's own private reference that EXISTS in the storage.
// A KYC status (PENDING, VERIFIED...) is NEVER evidence: an account can be PENDING with no document at all. Decided before any write; separate from the models' proofs.

const ALLOWED_DATA_URI = /^data:(image\/(png|jpe?g|webp)|application\/pdf);base64,/i;
export type StorageExists = (privateRef: string) => Promise<boolean>;

const missing = (message: string, code: 'DOCUMENT_REQUIRED' | 'DOCUMENT_INVALID') => new AppError(message, 400, [{ path: 'identity.frontId', field: 'identity.frontId', message, code }]);

async function confirmExists(exists: StorageExists, ref: string): Promise<boolean> {
	try { return await exists(ref); } catch { throw new AppError('تعذر التحقق من الملفات المرفوعة الآن، حاول مرة أخرى بعد قليل', 503); }
}

/** A stored value counts as a document only when it is trusted: legacy non-empty value, or an owned private reference that still exists. */
export async function storedFrontIsDocument(userId: string, storedFront: string | null | undefined, exists: StorageExists = privateFileExists): Promise<boolean> {
	if (typeof storedFront !== 'string' || storedFront.trim() === '') return false;
	if (!isPrivateRef(storedFront)) return true; // legacy stored value
	return privateRefBelongsTo(storedFront, userId) && await confirmExists(exists, storedFront);
}

/** True when this provider has a real identity document on file: the stored front, or any `otherStored` value (approved account document / waiting DOCUMENTS request). */
export async function identityDocumentOnFile(opts: { userId: string; storedFront: string | null | undefined; otherStored?: Array<string | null | undefined>; exists?: StorageExists }): Promise<boolean> {
	const exists = opts.exists ?? privateFileExists;
	for (const value of [opts.storedFront, ...(opts.otherStored ?? [])]) if (await storedFrontIsDocument(opts.userId, value, exists)) return true;
	return false;
}

export async function assertSetupIdentityFront(opts: { userId: string; frontId: unknown; storedFront: string | null | undefined; otherStored?: Array<string | null | undefined>; exists?: StorageExists }): Promise<void> {
	const { userId, frontId, storedFront } = opts;
	const exists: StorageExists = opts.exists ?? privateFileExists;
	const hasValue = typeof frontId === 'string' && frontId.trim() !== '';
	if (hasValue) {
		const value = frontId as string;
		if (value === storedFront) { // echoed back unchanged: the stored document must itself be real
			if (await storedFrontIsDocument(userId, storedFront, exists)) return;
			throw missing('صورة الهوية المخزّنة غير موجودة؛ ارفع صورة الهوية (الوجه الأمامي) مجددًا', 'DOCUMENT_REQUIRED');
		}
		const shapeOk = value.startsWith('data:') ? ALLOWED_DATA_URI.test(value) : isPrivateRef(value) && privateRefBelongsTo(value, userId);
		if (!shapeOk) throw missing('صورة الهوية (الوجه الأمامي) غير صالحة أو لا تخص حسابك؛ ارفعها من جهازك مجددًا', 'DOCUMENT_INVALID');
		if (isPrivateRef(value) && !(await confirmExists(exists, value))) throw missing('صورة الهوية غير موجودة أو لم يكتمل رفعها؛ ارفعها مجددًا', 'DOCUMENT_INVALID');
		return;
	}
	if (await identityDocumentOnFile({ userId, storedFront, otherStored: opts.otherStored, exists })) return;
	throw missing('صورة الهوية (الوجه الأمامي) مطلوبة، ارفع ملف PDF أو JPG أو PNG', 'DOCUMENT_REQUIRED');
}
