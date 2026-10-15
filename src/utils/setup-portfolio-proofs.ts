import { AppError } from './app-error';
import { sanitizeText } from './sanitize-text';
import { isOwnCloudinaryUrl } from './cloudinary-url';
import { privateRefBelongsTo, isPrivateRef } from './kyc-private-ref';

// Batch B T1 (§3): the work-model proof files of the provider setup (portfolio[<sub-specialty>][].review / .proofs). A value is a valid document only when it is
//  - a data: URI of an allowed type (the server uploads it into the caller's own folder), or
//  - a URL in OUR Cloudinary account inside the caller's OWN folder, or
//  - the caller's own private reference.
// A foreign link, another account's file or a bare string is refused, naming the sub-specialty field.

const ALLOWED_DATA_URI = /^data:(image\/(png|jpe?g|webp)|application\/(pdf|zip|x-zip-compressed));base64,/i;

export function isValidSetupProofValue(value: unknown, userId: string): boolean {
	if (typeof value !== 'string' || !value) return false;
	if (value.startsWith('data:')) return ALLOWED_DATA_URI.test(value);
	if (isPrivateRef(value)) return privateRefBelongsTo(value, userId);
	try { return isOwnCloudinaryUrl(value) && new URL(value).pathname.split('/').includes(userId); } catch { return false; }
}

const fieldError = (spec: string, message: string) => new AppError(message, 400, [{ path: `portfolio.${spec}`, field: `portfolio.${spec}`, message, code: 'PROOF_REQUIRED' }]);

/**
 * `portfolio` is validated only when it is sent (an absent key keeps what is stored). Every chosen sub-specialty needs at least one work model whose file
 * is a valid document; every sent file must be valid. Returns nothing; throws a 400 naming the first sub-specialty at fault.
 */
export function assertSetupPortfolioProofs(userId: string, portfolio: unknown, chosenSubSpecs: string[]): void {
	if (portfolio === undefined || portfolio === null) return;
	if (typeof portfolio !== 'object' || Array.isArray(portfolio)) throw new AppError('نماذج الأعمال غير صالحة', 400, [{ path: 'portfolio', field: 'portfolio', message: 'نماذج الأعمال غير صالحة' }]);
	// keys are sub-specialty names; they are compared after the same sanitising the rest of the setup gets
	const map: Record<string, unknown> = Object.fromEntries(Object.entries(portfolio as Record<string, unknown>).map(([k, v]) => [sanitizeText(k).trim(), v]));
	for (const spec of Object.keys(map)) {
		const items = Array.isArray(map[spec]) ? (map[spec] as any[]) : [];
		for (const item of items) {
			if (item?.review && !isValidSetupProofValue(item.review, userId)) throw fieldError(spec, `ملف نموذج العمل لتخصص «${spec}» غير صالح أو لا يخص حسابك؛ ارفعه من جهازك مجددًا`);
			for (const proof of Array.isArray(item?.proofs) ? item.proofs : []) {
				if (proof && !isValidSetupProofValue(proof, userId)) throw fieldError(spec, `أحد ملفات الإثبات لتخصص «${spec}» غير صالح أو لا يخص حسابك`);
			}
		}
	}
	for (const spec of chosenSubSpecs.map(c => sanitizeText(String(c)).trim()).filter(Boolean)) {
		const items = Array.isArray(map[spec]) ? (map[spec] as any[]) : [];
		if (!items.some(item => isValidSetupProofValue(item?.review, userId))) throw fieldError(spec, `ارفع نموذج عمل واحدًا على الأقل لتخصص «${spec}» (ملف صورة أو PDF حتى 15 ميجابايت)`);
	}
}
