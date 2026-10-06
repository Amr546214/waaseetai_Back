import { AppError } from './app-error';
import { isOwnCloudinaryUrl, ownCloudinaryUrlProblem } from './cloudinary-url';
import { isPrivateRef, privateRefBelongsTo } from './kyc-private-ref';

/**
 * KYC / identity / certificate fields accept only (a) a data: URI that the server then uploads itself, or (b) a URL that already points
 * into OUR Cloudinary account (a previously stored value echoed back). Any other string, in particular an external link, is refused.
 */
export function assertKycFileValue(value: unknown, ownerUserId?: string): void {
	if (value === undefined || value === null || value === '') return;
	if (typeof value !== 'string') throw new AppError('قيمة الملف غير صالحة', 400);
	// A stored private reference may be echoed back only by its owner (it sits in their own folder).
	if (isPrivateRef(value)) {
		if (ownerUserId && privateRefBelongsTo(value, ownerUserId)) return;
		throw new AppError('مرجع الملف غير صالح', 400);
	}
	if (value.startsWith('data:')) {
		// ID photos / documents / certificates: png, jpeg, webp or pdf only (the server also verifies the bytes when it uploads them).
		if (!/^data:(image\/(png|jpe?g|webp)|application\/pdf);base64,/i.test(value)) throw new AppError('نوع الملف غير مسموح به؛ ارفع صورة PNG أو JPG أو WEBP أو ملف PDF', 400);
		return;
	}
	const problem = ownCloudinaryUrlProblem(value);
	if (problem) throw new AppError(problem, 400);
}

/** For stored-document values submitted as plain strings (sensitive-change DOCUMENTS): own private reference, or a URL inside our own account. */
export function isAcceptableKycDocumentValue(value: string, ownerUserId?: string): boolean {
	if (isPrivateRef(value)) return !!ownerUserId && privateRefBelongsTo(value, ownerUserId);
	return isOwnCloudinaryUrl(value);
}

export function assertKycFileValues(values: unknown[], ownerUserId?: string): void {
	for (const v of values) assertKycFileValue(v, ownerUserId);
}
