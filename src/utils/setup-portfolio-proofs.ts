import { AppError } from './app-error';
import { sanitizeText } from './sanitize-text';
import { isOwnCloudinaryUrl } from './cloudinary-url';
import { privateRefBelongsTo, isPrivateRef } from './kyc-private-ref';
import { privateFileExists } from './cloudinary-storage';

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

// ───────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
// Business-model step of the provider setup, FULL rule (decided before any write):
//  - every chosen sub-specialty has at least one model with a model FILE (`review`) and at least one completed PROOF of ownership;
//  - the model file is never a substitute for its proof (same file as proof = refused); no proof is created from the model file;
//  - a NEW proof is a data: URI of an allowed type (the server uploads it) or the caller's own private reference that EXISTS in the storage (stat check,
//    fails closed when the storage cannot answer); a link, another account's file or a bare string is refused;
//  - files the provider already has stored are kept through their stored row (`id` + `keepReview` + `keepProofs` indexes), never through a link shape;
//    a legacy public URL stored on the provider's own rows is accepted when sent back unchanged (and only then).
// ───────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────

export const MODEL_TITLE_PREFIX = 'نموذج أعمال - ';
export interface StoredPortfolioRow { id: string; title: string; description: string | null; tags: string[]; coverImage: string | null }
export interface ResolvedPortfolioItem { spec: string; review: string; proofs: string[] }
export type StorageExists = (privateRef: string) => Promise<boolean>;

const failField = (spec: string, code: 'PROOF_REQUIRED' | 'PROOF_INVALID' | 'MODEL_FILE_REQUIRED', message: string) =>
	new AppError(message, 400, [{ path: `portfolio.${spec}`, field: `portfolio.${spec}`, message, code }]);
const blank = (v: unknown) => typeof v !== 'string' || v.trim() === '';

/** Existence of a stored private reference; a storage failure is a 503 (never "assume it exists"). */
async function confirmExists(exists: StorageExists, ref: string): Promise<boolean> {
	try { return await exists(ref); } catch { throw new AppError('تعذر التحقق من الملفات المرفوعة الآن، حاول مرة أخرى بعد قليل', 503); }
}

export async function resolveSetupPortfolio(opts: { userId: string; portfolio: unknown; chosenSubSpecs: string[]; stored: StoredPortfolioRow[]; exists?: StorageExists }): Promise<ResolvedPortfolioItem[]> {
	const { userId, portfolio, stored } = opts;
	const exists: StorageExists = opts.exists ?? privateFileExists;
	if (portfolio === undefined || portfolio === null) return [];
	if (typeof portfolio !== 'object' || Array.isArray(portfolio)) throw new AppError('نماذج الأعمال غير صالحة', 400, [{ path: 'portfolio', field: 'portfolio', message: 'نماذج الأعمال غير صالحة', code: 'PROOF_INVALID' }]);
	const storedValues = new Set<string>();
	for (const r of stored) { for (const v of [r.description, r.coverImage, ...(r.tags ?? [])]) if (typeof v === 'string' && v) storedValues.add(v); }
	const map: Record<string, unknown> = Object.fromEntries(Object.entries(portfolio as Record<string, unknown>).map(([k, v]) => [sanitizeText(k).trim(), v]));
	const resolved: ResolvedPortfolioItem[] = [];

	for (const spec of Object.keys(map)) {
		const items = Array.isArray(map[spec]) ? (map[spec] as any[]) : [];
		for (const item of items) {
			if (!item || typeof item !== 'object') continue;
			const row = typeof item.id === 'string' ? stored.find(r => r.id === item.id && sanitizeText(r.title).trim() === `${MODEL_TITLE_PREFIX}${spec}`) : undefined;

			// the model file
			let review = '';
			if (item.keepReview === true && row?.description) review = row.description;
			else if (!blank(item.review)) {
				if (!isValidSetupProofValue(item.review, userId)) throw failField(spec, 'PROOF_INVALID', `ملف نموذج العمل لتخصص «${spec}» غير صالح أو لا يخص حسابك؛ ارفعه من جهازك مجددًا`);
				if (isPrivateRef(item.review) && !(await confirmExists(exists, item.review))) throw failField(spec, 'PROOF_INVALID', `ملف نموذج العمل لتخصص «${spec}» غير موجود أو لم يكتمل رفعه؛ ارفعه مجددًا`);
				review = item.review;
			}

			// the proofs of ownership: kept ones (by index of the stored row) + new ones
			const proofs: string[] = [];
			if (row && Array.isArray(item.keepProofs)) {
				for (const idx of item.keepProofs) { const v = Number.isInteger(idx) ? row.tags?.[idx] : undefined; if (typeof v === 'string' && v && !proofs.includes(v)) proofs.push(v); }
			}
			for (const raw of Array.isArray(item.proofs) ? item.proofs : []) {
				if (blank(raw)) continue; // an upload placeholder that never completed is "no proof", not a value
				const ok = (typeof raw === 'string' && raw.startsWith('data:') && ALLOWED_DATA_URI.test(raw))
					|| (isPrivateRef(raw) && privateRefBelongsTo(raw, userId) && await confirmExists(exists, raw))
					|| (typeof raw === 'string' && storedValues.has(raw) && !isPrivateRef(raw));
				if (!ok) throw failField(spec, 'PROOF_INVALID', `أحد ملفات الإثبات لتخصص «${spec}» غير صالح أو غير موجود أو لا يخص حسابك`);
				if (!proofs.includes(raw)) proofs.push(raw);
			}

			if (!review && proofs.length === 0) continue; // an empty placeholder item
			if (!review) throw failField(spec, 'MODEL_FILE_REQUIRED', `ارفع ملف نموذج العمل لتخصص «${spec}» مع وثيقة إثبات الملكية`);
			const distinct = proofs.filter(p => p !== review);
			if (distinct.length === 0) throw failField(spec, 'PROOF_REQUIRED', proofs.length ? `وثيقة الإثبات لتخصص «${spec}» يجب أن تكون ملفًا مختلفًا عن ملف النموذج` : `أرفق وثيقة إثبات ملكية واحدة على الأقل لنموذج تخصص «${spec}»`);
			resolved.push({ spec, review, proofs: distinct });
		}
	}

	for (const spec of opts.chosenSubSpecs.map(c => sanitizeText(String(c)).trim()).filter(Boolean)) {
		if (!resolved.some(r => r.spec === spec)) throw failField(spec, 'MODEL_FILE_REQUIRED', `ارفع نموذج عمل واحدًا على الأقل لتخصص «${spec}» مع وثيقة إثبات الملكية (ملف صورة أو PDF حتى 15 ميجابايت)`);
	}
	return resolved;
}
