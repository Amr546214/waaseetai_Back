import { AppError } from './app-error';
import { isOwnCloudinaryUrl, ownCloudinaryUrlProblem } from './cloudinary-url';
import { isPrivateRef, parsePrivateRef, privateRefBelongsTo } from './kyc-private-ref';
import { UPLOAD_KINDS, uploadKindFolder, type UploadKind } from './provider-file-guard';

/**
 * KYC / identity / certificate fields accept only (a) a data: URI that the server then uploads itself, or (b) a URL that already points
 * into OUR Cloudinary account (a previously stored value echoed back). Any other string, in particular an external link, is refused.
 */
/**
 * A private reference made by the upload endpoint sits in `…/documents/<kind>/`. For a slot that expects a kind, a reference from ANOTHER kind's folder
 * (e.g. a logo uploaded as a work sample, offered as the identity document) is refused. A reference with no kind folder is a legacy upload (made before
 * kinds existed) and is still accepted.
 */
export function privateRefKindProblem(value: string, expected: UploadKind): string | null {
	const parsed = parsePrivateRef(value);
	if (!parsed) return null;
	const parts = parsed.publicId.split('/');
	const at = parts.lastIndexOf('documents');
	const folder = at >= 0 ? parts[at + 1] : undefined;
	if (folder === undefined || parts.length <= at + 2) return null; // `documents/<file>` directly: legacy
	if (!(UPLOAD_KINDS as readonly string[]).includes(folder.toUpperCase())) return null;
	return folder === uploadKindFolder(expected) ? null : 'هذا الملف لم يُرفع في هذا الحقل؛ ارفعه من جديد في الحقل الصحيح';
}

export function assertKycFileValue(value: unknown, ownerUserId?: string, storedValues?: ReadonlyArray<string | null | undefined>, expectedKind?: UploadKind): void {
	if (value === undefined || value === null || value === '') return;
	if (typeof value !== 'string') throw new AppError('قيمة الملف غير صالحة', 400);
	// The user's own value, echoed back unchanged (e.g. a legacy file name or a public URL the server itself stored): nothing new is being accepted.
	if (isStoredValueUnchanged(value, storedValues)) return;
	// A stored private reference may be echoed back only by its owner (it sits in their own folder).
	if (isPrivateRef(value)) {
		if (ownerUserId && privateRefBelongsTo(value, ownerUserId)) {
			const wrongKind = expectedKind ? privateRefKindProblem(value, expectedKind) : null;
			if (wrongKind) throw new AppError(wrongKind, 422);
			return;
		}
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

export function assertKycFileValues(values: unknown[], ownerUserId?: string, storedValues?: ReadonlyArray<string | null | undefined>, expectedKind?: UploadKind): void {
	for (const v of values) assertKycFileValue(v, ownerUserId, storedValues, expectedKind);
}

/**
 * true when `value` is EXACTLY one of the values this same user already has stored in the field(s) being saved (the caller reads them by userId
 * server-side). A re-save that did not change the file is then "keep", not a new link: it never needs re-validation and never re-uploads.
 * data: URIs are excluded (a new upload is always processed), and a value the user does not already own is never matched.
 */
export function isStoredValueUnchanged(value: unknown, storedValues?: ReadonlyArray<string | null | undefined>): boolean {
	if (typeof value !== 'string' || !value || value.startsWith('data:')) return false;
	return !!storedValues && storedValues.some(s => typeof s === 'string' && s === value);
}
