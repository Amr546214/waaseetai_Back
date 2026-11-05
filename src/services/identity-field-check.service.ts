import { createHash } from 'node:crypto';
import { Prisma } from '@prisma/client';
import { prisma } from '../config/db';
import { logger } from '../config/logger';
import { waseetAiClient } from './ai/waseet-ai/waseet-ai.client';
import { WaseetAiError, WaseetAiErrorCode } from './ai/waseet-ai/waseet-ai.errors';
import type { IdentityCompareFieldsRequest, IdentityCompareFieldsResponse, IdentityFieldName, IdentityFieldResult } from './ai/waseet-ai/waseet-ai.types';
import { createPrivateDownloadUrl } from '../utils/cloudinary-storage';
import { isPrivateRef, parsePrivateRef } from '../utils/kyc-private-ref';

/**
 * Automatic, ADVISORY field check of the uploaded Egyptian ID image against the data registered at submission time.
 *  - It never approves, rejects or changes any KYC/onboarding state: it only records per-field statuses for the admin.
 *  - Behind IDENTITY_AUTO_CHECK (default OFF): when off nothing is written and nothing is sent anywhere.
 *  - Stored per check: statuses + short reason codes + model name/version + timestamps. NO image, NO read card text. The registered snapshot
 *    (needed until the call is made) is erased the moment the check ends; only the masked national id (first 2 + last 2) and digests stay.
 *  - Idempotency key = user + party + image-reference digest + registered-data digest; a newer image always wins (see getAdminView: only the highest seq is shown).
 */

export type CheckParty = 'CLIENT' | 'PROVIDER';
export const NOT_EXAMINED = { faceMatch: 'NOT_EXAMINED', liveness: 'NOT_EXAMINED', documentAuthenticity: 'NOT_EXAMINED' } as const;
export const ADVISORY_NOTE_AR = 'نتائج الفحص الآلي استرشادية فقط ولا تُغني عن المراجعة اليدوية، ولا يترتب عليها قبول أو رفض تلقائي.';
export const MAX_ATTEMPTS = 3;
export const STALE_RUNNING_MS = 5 * 60 * 1000;
const FIELD_NAMES: IdentityFieldName[] = ['fullName', 'birthDate', 'nationalId'];
const MAX_IMAGE_BYTES = 12 * 1024 * 1024;

export function isIdentityAutoCheckEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
	return ['on', 'true', '1', 'yes'].includes(String(env.IDENTITY_AUTO_CHECK ?? '').trim().toLowerCase());
}

const sha256 = (v: string | Buffer) => createHash('sha256').update(v).digest('hex');
const ARABIC_DIGITS = '٠١٢٣٤٥٦٧٨٩';
export function normalizeDigits(v: string): string { return v.replace(/[٠-٩]/g, d => String(ARABIC_DIGITS.indexOf(d))).replace(/[\s-]/g, ''); }
/** First 2 + last 2 digits only; anything shorter than 8 is fully hidden. */
export function maskNationalId(v: string | null | undefined): string {
	const s = String(v ?? '');
	return s.length >= 8 ? `${s.slice(0, 2)}${'*'.repeat(s.length - 4)}${s.slice(-2)}` : '****';
}
const isoDate = (d: Date) => d.toISOString().slice(0, 10);

export interface RegisteredSnapshot { fullName: string; birthDate: string; nationalId: string; imageRef: string }

export interface IdentityCheckDeps {
	db: typeof prisma;
	ai: { compareIdentityFields(body: IdentityCompareFieldsRequest, opts?: { timeoutMs?: number; requestId?: string }): Promise<IdentityCompareFieldsResponse>; isConfigured(): boolean };
	fetchImage(privateRef: string): Promise<{ bytes: Buffer; mimeType: string }>;
	enabled(): boolean;
	now(): Date;
}

async function fetchPrivateImage(ref: string): Promise<{ bytes: Buffer; mimeType: string }> {
	const link = createPrivateDownloadUrl(ref, 60);
	if (!link) throw new Error('NO_LINK');
	const res = await globalThis.fetch(link.url, { signal: AbortSignal.timeout(20_000) });
	if (!res.ok) throw new Error(`HTTP_${res.status}`);
	const bytes = Buffer.from(await res.arrayBuffer());
	if (!bytes.length || bytes.length > MAX_IMAGE_BYTES) throw new Error('BAD_SIZE');
	const parsed = parsePrivateRef(ref);
	const fmt = (parsed?.format || '').toLowerCase();
	const mimeType = fmt === 'png' ? 'image/png' : fmt === 'webp' ? 'image/webp' : fmt === 'pdf' ? 'application/pdf' : 'image/jpeg';
	return { bytes, mimeType };
}

const defaultDeps = (): IdentityCheckDeps => ({
	db: prisma,
	ai: waseetAiClient,
	fetchImage: fetchPrivateImage,
	enabled: () => isIdentityAutoCheckEnabled(),
	now: () => new Date()
});

export type TriggerOutcome =
	| { action: 'DISABLED' | 'INCOMPLETE' | 'DUPLICATE' }
	| { action: 'CREATED' | 'RETRY' | 'REUSED' | 'SKIPPED'; checkId: string };

export function sanitizeFieldResults(raw: unknown): Record<IdentityFieldName, IdentityFieldResult> | null {
	if (!raw || typeof raw !== 'object') return null;
	const out: any = {};
	for (const name of FIELD_NAMES) {
		const f: any = (raw as any)[name];
		if (!f || !['MATCH', 'MISMATCH', 'COULD_NOT_VERIFY'].includes(f.status)) return null;
		out[name] = { status: f.status, ...(typeof f.reason === 'string' && /^[A-Z0-9_]{1,40}$/.test(f.reason) ? { reason: f.reason } : {}) };
	}
	return out;
}

function failureReason(e: unknown): string {
	if (e instanceof WaseetAiError) {
		if (e.code === WaseetAiErrorCode.NOT_CONFIGURED) return 'AI_NOT_CONFIGURED';
		if (e.code === WaseetAiErrorCode.INVALID_RESPONSE) return 'AI_BAD_RESPONSE';
		if (e.code === WaseetAiErrorCode.TIMEOUT) return 'AI_TIMEOUT';
		if (e.code === WaseetAiErrorCode.BAD_REQUEST || e.code === WaseetAiErrorCode.AUTHENTICATION_ERROR) return 'AI_REJECTED';
		return 'AI_UNAVAILABLE';
	}
	return 'AI_UNAVAILABLE';
}

export class IdentityFieldCheckService {
	constructor(private readonly deps: IdentityCheckDeps = defaultDeps()) {}

	/** Fire-and-forget entry for the submission hooks: never throws, never delays the request. */
	triggerSafe(userId: string, party: CheckParty): void {
		if (!this.deps.enabled()) return;
		void this.trigger(userId, party, { background: true }).catch(e => logger.warn(`[IdentityCheck] trigger failed party=${party} code=${(e as any)?.code ?? 'ERR'}`));
	}

	/** Reads the registered data NOW (the snapshot), then creates / reuses the check for this exact (image, data) pair. */
	async trigger(userId: string, party: CheckParty, opts: { background?: boolean } = {}): Promise<TriggerOutcome> {
		if (!this.deps.enabled()) return { action: 'DISABLED' };
		const reg = await this.loadRegistered(userId, party);
		if (!reg) return { action: 'INCOMPLETE' };
		const imageRefDigest = sha256(reg.imageRef);
		const dataDigest = sha256(JSON.stringify({ n: reg.fullName.trim().replace(/\s+/g, ' ').toLowerCase(), b: reg.birthDate, i: reg.nationalId }));
		const idempotencyKey = sha256(`${userId}|${party}|${imageRefDigest}|${dataDigest}`);
		const nationalIdMasked = maskNationalId(reg.nationalId);
		const skipReason = !/^\d{14}$/.test(reg.nationalId) ? 'NOT_EGYPTIAN_ID_FORMAT' : !isPrivateRef(reg.imageRef) ? 'IMAGE_NOT_IN_PRIVATE_STORAGE' : null;
		const now = this.deps.now();

		const outcome = await this.deps.db.$transaction(async (tx) => {
			// serialise per (user, party): seq allocation and the "newest image wins" bookkeeping cannot interleave
			await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`idc:${userId}:${party}`}))`;
			const latest = await tx.identityFieldCheck.findFirst({ where: { userId, party }, orderBy: { seq: 'desc' } });
			const existing = await tx.identityFieldCheck.findUnique({ where: { idempotencyKey } });
			const nextVersion = latest ? (latest.imageRefDigest === imageRefDigest ? latest.imageVersion : latest.imageVersion + 1) : 1;
			if (existing) {
				const staleRunning = existing.status === 'RUNNING' && now.getTime() - existing.updatedAt.getTime() > STALE_RUNNING_MS;
				const retryable = (existing.status === 'UNAVAILABLE' && existing.attempts < MAX_ATTEMPTS) || staleRunning;
				const notLatest = latest && latest.id !== existing.id;
				if (!retryable && !notLatest) return { action: 'DUPLICATE' as const };
				// same image + same data seen again: no new check. If an other image/data came in between, this one becomes the current (highest seq) again.
				const data: Prisma.IdentityFieldCheckUpdateInput = {
					...(notLatest ? { seq: latest!.seq + 1, imageVersion: nextVersion } : {}),
					...(retryable ? { status: 'QUEUED', stateReason: null, registeredSnapshot: reg as any } : {})
				};
				await tx.identityFieldCheck.update({ where: { id: existing.id }, data });
				if (notLatest) await this.supersedeQueued(tx, userId, party, existing.id);
				return retryable ? { action: 'RETRY' as const, checkId: existing.id } : { action: 'REUSED' as const, checkId: existing.id };
			}
			try {
				const row = await tx.identityFieldCheck.create({
					data: {
						userId, party, seq: (latest?.seq ?? 0) + 1, imageVersion: nextVersion, imageRefDigest, dataDigest, idempotencyKey, nationalIdMasked,
						status: skipReason ? 'SKIPPED' : 'QUEUED', stateReason: skipReason, finishedAt: skipReason ? now : null,
						registeredSnapshot: skipReason ? Prisma.JsonNull : (reg as any)
					}
				});
				await this.supersedeQueued(tx, userId, party, row.id);
				return skipReason ? { action: 'SKIPPED' as const, checkId: row.id } : { action: 'CREATED' as const, checkId: row.id };
			} catch (e: any) {
				if (e?.code === 'P2002') return { action: 'DUPLICATE' as const }; // lost a race on the unique key: the other request owns the check
				throw e;
			}
		});

		if ((outcome.action === 'CREATED' || outcome.action === 'RETRY') && 'checkId' in outcome) {
			if (opts.background) setImmediate(() => void this.run(outcome.checkId).catch(e => logger.warn(`[IdentityCheck] run failed check=${outcome.checkId} code=${(e as any)?.code ?? 'ERR'}`)));
			else await this.run(outcome.checkId);
		}
		return outcome;
	}

	private async supersedeQueued(tx: Prisma.TransactionClient, userId: string, party: CheckParty, exceptId: string) {
		await tx.identityFieldCheck.updateMany({
			where: { userId, party, status: 'QUEUED', id: { not: exceptId } },
			data: { status: 'SKIPPED', stateReason: 'SUPERSEDED', finishedAt: this.deps.now(), registeredSnapshot: Prisma.JsonNull }
		});
	}

	private async loadRegistered(userId: string, party: CheckParty): Promise<RegisteredSnapshot | null> {
		const user = await this.deps.db.user.findUnique({ where: { id: userId }, select: { firstName: true, lastName: true } });
		if (!user) return null;
		const p: any = party === 'CLIENT'
			? await this.deps.db.clientProfile.findUnique({ where: { userId }, select: { idNumber: true, dob: true, frontIdUrl: true } })
			: await this.deps.db.providerProfile.findUnique({ where: { userId }, select: { idNumber: true, dob: true, frontIdUrl: true } });
		const fullName = `${user.firstName ?? ''} ${user.lastName ?? ''}`.trim();
		const nationalId = normalizeDigits(String(p?.idNumber ?? ''));
		if (!p || !fullName || !nationalId || !(p.dob instanceof Date) || Number.isNaN(p.dob.getTime()) || !p.frontIdUrl) return null;
		return { fullName, birthDate: isoDate(p.dob), nationalId, imageRef: String(p.frontIdUrl) };
	}

	/** Runs one QUEUED check. Claim is a conditional update (one runner wins); the result is written ONLY to this row while it is still RUNNING. */
	async run(checkId: string): Promise<void> {
		const db = this.deps.db;
		const claimed = await db.identityFieldCheck.updateMany({ where: { id: checkId, status: 'QUEUED' }, data: { status: 'RUNNING', startedAt: this.deps.now(), attempts: { increment: 1 } } });
		if (claimed.count !== 1) return;
		const row = await db.identityFieldCheck.findUnique({ where: { id: checkId } });
		if (!row) return;
		const finish = async (data: Prisma.IdentityFieldCheckUpdateManyMutationInput) =>
			db.identityFieldCheck.updateMany({ where: { id: checkId, status: 'RUNNING' }, data: { ...data, finishedAt: this.deps.now(), registeredSnapshot: Prisma.JsonNull } });
		const snap = row.registeredSnapshot as unknown as RegisteredSnapshot | null;
		if (!snap?.imageRef) { await finish({ status: 'SKIPPED', stateReason: 'NO_SNAPSHOT' }); return; }
		// a newer check for this user appeared meanwhile: do not spend an AI call on a superseded image
		const newer = await db.identityFieldCheck.findFirst({ where: { userId: row.userId, party: row.party, seq: { gt: row.seq } }, select: { id: true } });
		if (newer) { await finish({ status: 'SKIPPED', stateReason: 'SUPERSEDED' }); return; }
		if (!this.deps.ai.isConfigured()) { await finish({ status: 'UNAVAILABLE', stateReason: 'AI_NOT_CONFIGURED' }); return; }
		let image: { bytes: Buffer; mimeType: string };
		try { image = await this.deps.fetchImage(snap.imageRef); }
		catch { await finish({ status: 'UNAVAILABLE', stateReason: 'IMAGE_FETCH_FAILED' }); return; }
		try {
			const res = await this.deps.ai.compareIdentityFields({
				requestId: row.id,
				image: image.bytes.toString('base64'),
				imageMimeType: image.mimeType,
				registered: { fullName: snap.fullName, birthDate: snap.birthDate, nationalId: snap.nationalId }
			}, { timeoutMs: 45_000, requestId: row.id });
			const fields = sanitizeFieldResults(res.fields);
			if (!fields || res.requestId !== row.id) { await finish({ status: 'UNAVAILABLE', stateReason: 'AI_BAD_RESPONSE' }); return; }
			await finish({
				status: 'DONE', stateReason: null, fieldResults: fields as any, imageSha256: sha256(image.bytes),
				modelName: String(res.model.name).slice(0, 120), modelVersion: String(res.model.version).slice(0, 120), aiRequestId: row.id
			});
		} catch (e) {
			await finish({ status: 'UNAVAILABLE', stateReason: failureReason(e) });
		}
		logger.info(`[IdentityCheck] check=${row.id} party=${row.party} v=${row.imageVersion} finished`);
	}

	// ── Reads ───────────────────────────────────────────────────────────────

	private async latestAndCurrent(userId: string, party: CheckParty) {
		const [latest, profile] = await Promise.all([
			this.deps.db.identityFieldCheck.findFirst({ where: { userId, party }, orderBy: { seq: 'desc' } }),
			party === 'CLIENT'
				? this.deps.db.clientProfile.findUnique({ where: { userId }, select: { frontIdUrl: true } })
				: this.deps.db.providerProfile.findUnique({ where: { userId }, select: { frontIdUrl: true } })
		]);
		return { latest, profile };
	}

	/** null = no such profile (404). */
	async getAdminView(userId: string, party: CheckParty) {
		const { latest, profile } = await this.latestAndCurrent(userId, party);
		if (!profile) return null;
		const enabled = this.deps.enabled();
		const base = { userId, party, autoCheckEnabled: enabled, manualReviewRequired: true, advisory: true, advisoryNote: ADVISORY_NOTE_AR, notExamined: NOT_EXAMINED };
		const none = (stateReason: string, extra: object = {}) => ({ ...base, state: 'NOT_CHECKED', stateReason, imageVersion: null, stale: false, startedAt: null, checkedAt: null, model: null, fields: null, ...extra });
		if (!latest) return none(enabled ? 'NO_CHECK_YET' : 'FLAG_OFF');
		const stale = !!profile.frontIdUrl && sha256(String(profile.frontIdUrl)) !== latest.imageRefDigest;
		const imageVersion = { version: latest.imageVersion, digest: latest.imageRefDigest.slice(0, 12), submittedAt: latest.createdAt.toISOString() };
		if (stale) return none('STALE_IMAGE', { imageVersion, stale: true });
		const done = latest.status === 'DONE';
		return {
			...base,
			state: latest.status, stateReason: latest.stateReason ?? null, imageVersion, stale: false,
			startedAt: latest.startedAt?.toISOString() ?? null, checkedAt: latest.finishedAt?.toISOString() ?? null,
			model: done && latest.modelName ? { name: latest.modelName, version: latest.modelVersion } : null,
			fields: done ? sanitizeFieldResults(latest.fieldResults) : null
		};
	}

	/** Neutral for the account owner: a check for the CURRENT image exists = "IN_REVIEW"; nothing else is ever revealed. */
	async getOwnerView(userId: string, party: CheckParty): Promise<{ state: 'IN_REVIEW' | 'NONE' }> {
		const { latest, profile } = await this.latestAndCurrent(userId, party);
		if (!latest || !profile?.frontIdUrl || sha256(String(profile.frontIdUrl)) !== latest.imageRefDigest) return { state: 'NONE' };
		return { state: 'IN_REVIEW' };
	}
}

export const identityFieldCheckService = new IdentityFieldCheckService();
