import { AppError } from './app-error';
import { isPrivateRef, privateRefBelongsTo } from './kyc-private-ref';
import { privateFileExists } from './cloudinary-storage';

// Provider setup, identity step: the FRONT of the ID is the required evidence (the back, the number and certificates are optional). It is satisfied by
//  - a stored front (an earlier submission) or an identity review already running / decided (PENDING, VERIFIED: the documents are on file), or
//  - a NEW front sent now that is a data: URI of an allowed type or the caller's own private reference that EXISTS in the storage.
// This is decided before any write of the setup request; the front of the identity is separate from the ownership proofs of the business models.

const ALLOWED_DATA_URI = /^data:(image\/(png|jpe?g|webp)|application\/pdf);base64,/i;
export type StorageExists = (privateRef: string) => Promise<boolean>;

const missing = (message: string, code: 'DOCUMENT_REQUIRED' | 'DOCUMENT_INVALID') => new AppError(message, 400, [{ path: 'identity.frontId', field: 'identity.frontId', message, code }]);

export async function assertSetupIdentityFront(opts: {
	userId: string; frontId: unknown; storedFront: string | null | undefined; kycStatus: string | null | undefined; exists?: StorageExists;
}): Promise<void> {
	const { userId, frontId, storedFront, kycStatus } = opts;
	const exists: StorageExists = opts.exists ?? privateFileExists;
	const hasValue = typeof frontId === 'string' && frontId.trim() !== '';
	if (hasValue) {
		const value = frontId as string;
		if (value === storedFront) return; // unchanged, already stored and verified when it was stored
		const shapeOk = value.startsWith('data:') ? ALLOWED_DATA_URI.test(value) : isPrivateRef(value) && privateRefBelongsTo(value, userId);
		if (!shapeOk) throw missing('صورة الهوية (الوجه الأمامي) غير صالحة أو لا تخص حسابك؛ ارفعها من جهازك مجددًا', 'DOCUMENT_INVALID');
		if (isPrivateRef(value)) {
			let there: boolean;
			try { there = await exists(value); } catch { throw new AppError('تعذر التحقق من الملفات المرفوعة الآن، حاول مرة أخرى بعد قليل', 503); }
			if (!there) throw missing('صورة الهوية غير موجودة أو لم يكتمل رفعها؛ ارفعها مجددًا', 'DOCUMENT_INVALID');
		}
		return;
	}
	if (typeof storedFront === 'string' && storedFront) return;
	if (kycStatus === 'PENDING' || kycStatus === 'VERIFIED') return;
	throw missing('صورة الهوية (الوجه الأمامي) مطلوبة، ارفع ملف PDF أو JPG أو PNG', 'DOCUMENT_REQUIRED');
}
