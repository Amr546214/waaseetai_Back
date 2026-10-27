import { LogCategory, Prisma } from '@prisma/client';
import { prisma as defaultPrisma } from '../config/db';
import { logger } from '../config/logger';
import { AppError, fieldError } from '../utils/app-error';
import { isMissingTableError } from '../utils/missing-table';
import { accountAuditLogService } from './account-logs.service';
import { createHash } from 'node:crypto';
import { EMAIL_LOGO_KEY, refreshSiteIdentityCache, registerSiteIdentityCacheLoader } from './site-identity-cache';
import { sha256Of, validateIdentityUpload } from '../utils/site-identity-upload';
import { buildTokensCss, validateTokenBytes, TokenSets } from '../utils/site-identity-tokens';
import { TOKEN_KEYS, TokenKey, isTokenKey, tokenSpecOut } from '../config/site-identity-tokens';
import {
	IDENTITY_GROUPS, KEY_PATTERN, NOT_IDENTITY_NOTES, SITE_IDENTITY_REGISTRY, UNREGISTERED_PRESENT_ASSETS, WIRED_KEYS, SiteIdentityKeyDef, describeRules, identityDef, isWiredKey,
} from '../config/site-identity.registry';

/**
 * Site identity («التحكم بالموقع» > الهوية): versioned, rollback-able logos / favicon / AI icon / characters stored in PostgreSQL.
 *
 * Invariants (tests: site-identity.pg.test.ts):
 *  - a key with no state row, or a NULL pointer, IS the built-in default asset (nothing is stored for defaults);
 *  - ONE transaction per publish / restore / restore-set: asset statuses + state rows + manifest row + audit row commit together, after a read-back INSIDE the transaction proved the stored bytes still hash to
 *    the recorded sha256; a failure at any step rolls everything back and the active identity is untouched. After the commit the result is read again through a fresh query; success is returned only when that
 *    also matches (otherwise the change is reverted by a compensating transaction and the caller gets an honest error);
 *  - every mutation takes ONE advisory lock (so a publish and a restore-set can never interleave) and compares the caller's `expectedVersion` with the stored one: the loser gets 409 + the winner's state;
 *  - PUBLISHED / SUPERSEDED rows are never deleted or modified except for their status (rollback needs the bytes); only a DISCARDED staged upload drops its bytes.
 */

export const SITE_IDENTITY_VERSION_CONFLICT = 'SITE_IDENTITY_VERSION_CONFLICT';
export const SITE_IDENTITY_ERRORS = {
	UNKNOWN_KEY: 'SITE_IDENTITY_UNKNOWN_KEY', NOT_WIRED: 'SITE_IDENTITY_KEY_NOT_WIRED', VERSION_NOT_FOUND: 'SITE_IDENTITY_VERSION_NOT_FOUND', NOT_STAGED: 'SITE_IDENTITY_VERSION_NOT_STAGED',
	NOT_RESTORABLE: 'SITE_IDENTITY_VERSION_NOT_RESTORABLE', NO_CHANGE: 'SITE_IDENTITY_NO_CHANGE', TOO_MANY_STAGED: 'SITE_IDENTITY_TOO_MANY_STAGED', VERIFY_FAILED: 'SITE_IDENTITY_VERIFY_FAILED',
	UNAVAILABLE: 'SITE_IDENTITY_UNAVAILABLE', MANIFEST_NOT_FOUND: 'SITE_IDENTITY_MANIFEST_NOT_FOUND', PREVIEW_STALE: 'SITE_IDENTITY_PREVIEW_STALE', DRAFT_NOT_YOURS: 'SITE_IDENTITY_DRAFT_NOT_YOURS',
} as const;
export const MAX_STAGED_PER_KEY = 5;
export const HISTORY_PER_KEY = 10;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SHA_RE = /^[0-9a-f]{64}$/;
const LOCK_NAME = 'site-identity:mutate';
const stageLock = (key: string) => `site-identity:stage:${key}`;

/** 409 whose body carries the CURRENT state so the page can show what the winner did (the global error handler only forwards a fixed set of fields, so the routes render this one themselves) */
export class SiteIdentityConflict extends AppError {
	constructor(message: string, public readonly current: unknown, code: string = SITE_IDENTITY_VERSION_CONFLICT) { super(message, 409, undefined, code); }
}

type Tx = Prisma.TransactionClient;
type Db = typeof defaultPrisma;
const META = { id: true, key: true, version: true, status: true, mime: true, sha256: true, width: true, height: true, byteSize: true, note: true, createdById: true, createdAt: true } as const;
interface AssetMeta { id: string; key: string; version: number; status: string; mime: string; sha256: string; width: number | null; height: number | null; byteSize: number; note: string | null; createdById: string | null; createdAt: Date }
export interface AuditCtx { ip?: string; device?: string }

/** test-only seams (constructor argument, never reachable from a request): inject a failure inside the transaction, corrupt the read-back, or fail the post-commit verification */
export interface SiteIdentityFaults {
	insideTx?: (tx: Tx, step: 'after-state' | 'after-manifest' | 'after-audit') => Promise<void> | void;
	readBack?: (row: { bytes: Uint8Array | null; sha256: string }) => { bytes: Uint8Array | null; sha256: string };
	postCommit?: () => Promise<void> | void;
}
export interface SiteIdentityOptions { db?: Db; isWired?: (key: string) => boolean; faults?: SiteIdentityFaults }

const publicPath = (key: string, sha: string) => `/public/site-identity/assets/${key}/${sha}`;
const short = (sha: string) => sha.slice(0, 12);
const assetOut = (a: AssetMeta) => ({ versionId: a.id, key: a.key, version: a.version, status: a.status, mime: a.mime, sha256: a.sha256, width: a.width, height: a.height, byteSize: a.byteSize, note: a.note, createdById: a.createdById, createdAt: a.createdAt.toISOString(),
	url: a.status === 'PUBLISHED' || a.status === 'SUPERSEDED' ? publicPath(a.key, a.sha256) : null, previewUrl: a.status === 'DISCARDED' ? null : `/admin/site-identity/${a.key}/versions/${a.id}/preview` });

/**
 * ACTORS: every `createdById` / `updatedById` leaving the admin API becomes `createdBy` / `updatedBy` = { id, name } (name: first + last, or the company name of a company account; null for a deleted /
 * unknown user). ONE batched query per response (no N+1); nothing else about the person is selected, let alone returned. Never applied to public responses.
 */
export interface ActorRef { id: string; name: string | null }
export const actorName = (u: { firstName?: string | null; lastName?: string | null; accountType?: string; clientProfile?: { companyName: string | null } | null; providerProfile?: { companyName: string | null } | null }): string | null => {
	const company = u.accountType === 'CLIENT_COMPANY' ? u.clientProfile?.companyName : u.accountType === 'PROVIDER_COMPANY' ? u.providerProfile?.companyName : null;
	const n = (company && company.trim()) || `${u.firstName ?? ''} ${u.lastName ?? ''}`.trim();
	return n ? n.replace(/[\u0000-\u001F\u007F]/g, ' ').slice(0, 120) : null;
};
async function withActors<T>(db: Tx | Db, payload: T): Promise<T> {
	const ids = new Set<string>();
	const FIELDS: Record<string, string> = { createdById: 'createdBy', updatedById: 'updatedBy' };
	const collect = (v: unknown) => { if (Array.isArray(v)) v.forEach(collect); else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) { if (FIELDS[k] && typeof x === 'string') ids.add(x); else collect(x); } };
	collect(payload);
	const names = new Map<string, string | null>();
	if (ids.size) {
		const users = await db.user.findMany({ where: { id: { in: [...ids] } }, select: { id: true, firstName: true, lastName: true, accountType: true, clientProfile: { select: { companyName: true } }, providerProfile: { select: { companyName: true } } } });
		for (const u of users) names.set(u.id, actorName(u));
	}
	const walk = (v: unknown): unknown => {
		if (Array.isArray(v)) return v.map(walk);
		if (v && typeof v === 'object') {
			const out: Record<string, unknown> = {};
			for (const [k, x] of Object.entries(v)) { if (FIELDS[k]) out[FIELDS[k]] = typeof x === 'string' ? ({ id: x, name: names.get(x) ?? null } as ActorRef) : null; else out[k] = walk(x); }
			return out;
		}
		return v;
	};
	return withValues(db, walk(payload) as T);
}

/**
 * TOKEN VALUES: every version object of a json (design-token) key (an object carrying `versionId` and mime application/json) gets `value` = its sparse override object; a default side (`source:'default'`) gets `{}`.
 * One batched query; the stored canonical JSON is validated again (never trusted blindly: a row that fails validation yields `{}`). Files (png/svg/ico) are untouched. Mutates the freshly built payload in place.
 */
export async function withValues<T>(db: Tx | Db, payload: T): Promise<T> {
	const ids = new Set<string>(); const targets: Array<Record<string, unknown>> = [];
	const visit = (v: unknown) => {
		if (Array.isArray(v)) { v.forEach(visit); return; }
		if (!v || typeof v !== 'object') return;
		const o = v as Record<string, unknown>;
		if (o.mime === 'application/json' && (typeof o.versionId === 'string' || o.source === 'default')) { targets.push(o); if (typeof o.versionId === 'string') ids.add(o.versionId); }
		for (const x of Object.values(o)) visit(x);
	};
	visit(payload);
	if (!targets.length) return payload;
	const rows = ids.size ? await db.siteIdentityAsset.findMany({ where: { id: { in: [...ids] } }, select: { id: true, key: true, bytes: true } }) : [];
	const by = new Map(rows.map(r => [r.id, r]));
	for (const o of targets) {
		const r = typeof o.versionId === 'string' ? by.get(o.versionId) : null;
		if (!r || !r.bytes || !isTokenKey(r.key)) { o.value = {}; continue; }
		try { o.value = validateTokenBytes(r.key, r.bytes, { allowEmpty: true }).value; } catch { o.value = {}; }
	}
	return payload;
}

export class SiteIdentityService {
	private db: Db; private isWiredFn: (key: string) => boolean; private faults: SiteIdentityFaults;
	constructor(opts: SiteIdentityOptions = {}) { this.db = opts.db ?? defaultPrisma; this.isWiredFn = opts.isWired ?? ((k) => isWiredKey(k, WIRED_KEYS)); this.faults = opts.faults ?? {}; }

	isWired(key: string) { return this.isWiredFn(key); }
	/** the registry entry or a 404 / 400 */
	private def(key: string): SiteIdentityKeyDef {
		const d = KEY_PATTERN.test(String(key)) ? identityDef(String(key)) : null;
		if (!d) throw new AppError('عنصر الهوية غير موجود.', 404, undefined, SITE_IDENTITY_ERRORS.UNKNOWN_KEY);
		return d;
	}
	private writable(key: string): SiteIdentityKeyDef {
		const d = this.def(key);
		if (!this.isWired(key)) throw new AppError(`هذا العنصر غير مرتبط بالموقع بعد، فلا يمكن تعديله. ${d.notWiredReason}`, 409, undefined, SITE_IDENTITY_ERRORS.NOT_WIRED);
		return d;
	}
	private async lock(tx: Tx, name: string) { await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${name}, 0))::text AS locked`; }
	private guard<T>(fn: () => Promise<T>): Promise<T> {
		return fn().catch((e) => { if (isMissingTableError(e)) throw new AppError('نظام الهوية غير جاهز على هذه البيئة بعد: لم يُطبَّق تحديث قاعدة البيانات اللازم (site_identity_*). يرجى مراجعة فريق التشغيل.', 503, undefined, SITE_IDENTITY_ERRORS.UNAVAILABLE); throw e; });
	}

	// ------------------------------------------------------------------------------------------------------------------ reads
	/** the whole page: registry + state + per-key history summary */
	async overview(canManage: boolean, callerId: string | null = null) {
		return this.guard(async () => {
			const [states, assets, mv] = await Promise.all([
				this.db.siteIdentityState.findMany(),
				this.db.siteIdentityAsset.findMany({ select: META, orderBy: [{ key: 'asc' }, { version: 'desc' }] }),
				this.db.siteIdentityManifest.aggregate({ _max: { version: true } }),
			]);
			const stateBy = new Map(states.map(s => [s.key, s])); const byKey = new Map<string, AssetMeta[]>();
			for (const a of assets as AssetMeta[]) { const l = byKey.get(a.key) ?? []; l.push(a); byKey.set(a.key, l); }
			const items = SITE_IDENTITY_REGISTRY.map(d => {
				const st = stateBy.get(d.key); const rows = byKey.get(d.key) ?? []; const wired = this.isWired(d.key);
				const active = st?.activeAssetId ? rows.find(r => r.id === st.activeAssetId) ?? null : null;
				return {
					key: d.key, group: d.group, label: d.label, description: d.description, kind: d.kind, allowedMimes: d.allowedMimes, maxBytes: d.maxBytes, dimensions: d.dimensions, rules: describeRules(d),
					defaultAsset: d.defaultAsset, defaultFingerprint: d.defaultFingerprint, ...(d.kind === 'json' ? { tokens: tokenSpecOut(d.key) } : {}), usages: d.usages, notes: d.notes ?? [], wired, editable: wired, notWiredReason: wired ? null : d.notWiredReason,
					state: { stateVersion: st?.version ?? 0, isDefault: !active, active: active ? assetOut(active) : null, updatedAt: st?.updatedAt?.toISOString() ?? null, updatedById: st?.updatedById ?? null },
					staged: rows.filter(r => r.status === 'STAGED').map(r => ({ ...assetOut(r), isMine: !!callerId && r.createdById === callerId })),
					history: rows.filter(r => r.status !== 'STAGED').slice(0, HISTORY_PER_KEY).map(assetOut),
				};
			});
			return withActors(this.db, { manifestVersion: mv._max.version ?? 0, canManage, groups: IDENTITY_GROUPS, items, notIdentity: NOT_IDENTITY_NOTES, unregisteredAssets: UNREGISTERED_PRESENT_ASSETS });
		});
	}

	async history(query: { key?: unknown; limit?: unknown; before?: unknown }) {
		const key = query.key === undefined || query.key === '' ? null : this.def(String(query.key)).key;
		const limit = Math.min(100, Math.max(1, Number.isInteger(Number(query.limit)) ? Number(query.limit) : 30));
		const before = Number.isInteger(Number(query.before)) && Number(query.before) > 0 ? Number(query.before) : null;
		return this.guard(async () => {
			const rows = await this.db.siteIdentityManifest.findMany({ where: before ? { version: { lt: before } } : {}, orderBy: { version: 'desc' }, take: limit + 1 });
			const page = rows.slice(0, limit);
			const prev = page.length ? await this.db.siteIdentityManifest.findUnique({ where: { version: page[page.length - 1].version - 1 } }) : null;
			const out = page.map((r, i) => {
				const older = (i + 1 < page.length ? page[i + 1] : prev)?.snapshot as Record<string, string | null> | undefined; const snap = r.snapshot as Record<string, string | null>;
				const changedKeys = Object.keys({ ...(older ?? {}), ...snap }).filter(k => (snap[k] ?? null) !== ((older ?? {})[k] ?? null));
				return { manifestVersion: r.version, reason: r.reason, createdAt: r.createdAt.toISOString(), createdById: r.createdById, changedKeys: key ? changedKeys.filter(k => k === key) : changedKeys };
			}).filter(r => !key || r.changedKeys.length > 0);
			const versions = await this.db.siteIdentityAsset.findMany({ where: key ? { key } : {}, select: META, orderBy: [{ createdAt: 'desc' }], take: 200 });
			return withActors(this.db, { manifest: out, hasMore: rows.length > limit, nextBefore: rows.length > limit ? page[page.length - 1].version : null, versions: (versions as AssetMeta[]).map(assetOut) });
		});
	}

	/** the bytes of one version for the admin preview (any version of that key except a discarded one) */
	async previewBytes(key: string, versionId: string) {
		this.def(key); if (!UUID_RE.test(String(versionId))) throw new AppError('معرّف النسخة غير صالح.', 400, undefined, SITE_IDENTITY_ERRORS.VERSION_NOT_FOUND);
		return this.guard(async () => {
			const r = await this.db.siteIdentityAsset.findFirst({ where: { id: String(versionId), key }, select: { mime: true, bytes: true, status: true, sha256: true } });
			if (!r || !r.bytes || r.status === 'DISCARDED') throw new AppError('النسخة غير موجودة أو حُذفت.', 404, undefined, SITE_IDENTITY_ERRORS.VERSION_NOT_FOUND);
			return { mime: r.mime, bytes: Buffer.from(r.bytes), sha256: r.sha256 };
		});
	}

	/**
	 * PUBLIC: ONLY the keys that have an active custom version (and are wired). Nothing about history, storage, uploaders.
	 * Design-token items carry their validated sparse `value` inline (no second request) and `tokensCss` is the ready-to-inject CSS built from them ('' = nothing to inject = today's look).
	 */
	async publicManifest(): Promise<PublicManifest> {
		try {
			const states = await this.db.siteIdentityState.findMany({ where: { activeAssetId: { not: null } }, include: { activeAsset: { select: META } } });
			const mv = await this.db.siteIdentityManifest.aggregate({ _max: { version: true } });
			const items: PublicManifest['items'] = {};
			const tokenIds: string[] = [];
			for (const s of [...states].sort((a, b) => a.key.localeCompare(b.key))) {
				const a = s.activeAsset; if (!a || !identityDef(s.key) || !this.isWired(s.key)) continue;
				items[s.key] = { url: publicPath(s.key, a.sha256), sha256: a.sha256, mime: a.mime, width: a.width, height: a.height, version: a.version };
				if (isTokenKey(s.key)) tokenIds.push(a.id);
			}
			const sets: TokenSets = {};
			if (tokenIds.length) {
				const rows = await this.db.siteIdentityAsset.findMany({ where: { id: { in: tokenIds } }, select: { id: true, key: true, bytes: true } });
				for (const r of rows) {
					try {
						if (!r.bytes || !isTokenKey(r.key)) throw new Error('no bytes');
						const value = validateTokenBytes(r.key, r.bytes, { allowEmpty: true }).value;
						items[r.key].value = value; sets[r.key as TokenKey] = value;
					} catch (e) { delete items[r.key]; logger.warn(`[SiteIdentity] stored token set ${r.key} failed validation and is ignored (default shown): ${(e as Error)?.message ?? e}`); }
				}
			}
			const tokensCss = buildTokensCss(sets);
			return tokensCss ? { version: mv._max.version ?? 0, items, tokensCss } : { version: mv._max.version ?? 0, items }; // the key is ABSENT when there is nothing to inject: the empty manifest stays byte-identical to the one deployed before tokens existed
		} catch (e) {
			if (isMissingTableError(e)) return { version: 0, items: {} }; // migration not applied here: everything is the built-in default
			throw e;
		}
	}

	/** PUBLIC: the bytes behind /assets/:key/:sha256 - only PUBLISHED or SUPERSEDED rows (a superseded one was active in some manifest, so open pages that still hold its URL keep working); never STAGED / DISCARDED */
	async publicAsset(key: string, sha256: string): Promise<{ mime: string; bytes: Buffer } | null> {
		if (!KEY_PATTERN.test(String(key)) || !identityDef(String(key)) || !SHA_RE.test(String(sha256))) return null;
		try {
			const r = await this.db.siteIdentityAsset.findFirst({ where: { key: String(key), sha256: String(sha256), status: { in: ['PUBLISHED', 'SUPERSEDED'] } }, orderBy: { version: 'desc' }, select: { mime: true, bytes: true } });
			return r?.bytes ? { mime: r.mime, bytes: Buffer.from(r.bytes) } : null;
		} catch (e) { if (isMissingTableError(e)) return null; throw e; }
	}

	// ------------------------------------------------------------------------------------------------------------------ state view (for conflict bodies and results)
	private async keyState(db: Tx | Db, key: string) {
		const st = await db.siteIdentityState.findUnique({ where: { key }, include: { activeAsset: { select: META } } });
		const mv = await db.siteIdentityManifest.aggregate({ _max: { version: true } });
		return withActors(db, { key, stateVersion: st?.version ?? 0, manifestVersion: mv._max.version ?? 0, isDefault: !st?.activeAsset, active: st?.activeAsset ? assetOut(st.activeAsset as AssetMeta) : null, updatedAt: st?.updatedAt?.toISOString() ?? null, updatedById: st?.updatedById ?? null });
	}
	private async fullState(db: Tx | Db) {
		const [states, mv] = await Promise.all([db.siteIdentityState.findMany({ include: { activeAsset: { select: META } } }), db.siteIdentityManifest.aggregate({ _max: { version: true } })]);
		const snap = await db.siteIdentityManifest.findUnique({ where: { version: mv._max.version ?? -1 } });
		return withActors(db, { manifestVersion: mv._max.version ?? 0, snapshot: (snap?.snapshot ?? {}) as Record<string, string | null>, keys: states.map(s => ({ key: s.key, stateVersion: s.version, isDefault: !s.activeAsset, active: s.activeAsset ? assetOut(s.activeAsset as AssetMeta) : null })) });
	}

	// ------------------------------------------------------------------------------------------------------------------ stage (upload)
	async stage(key: string, file: { buffer: Buffer; mimetype?: string } | undefined, actorId: string, ctx: AuditCtx = {}) {
		const def = this.writable(key);
		if (!file || !file.buffer) throw fieldError('file', 'اختر ملفًا لرفعه (الحقل file).');
		const v = await validateIdentityUpload(def, file.buffer, file.mimetype); // throws UploadRejected / SvgRejected (400, SITE_IDENTITY_FILE_REJECTED)
		return this.guard(async () => {
			let retries = 0;
			for (;;) {
				try {
					return await this.db.$transaction(async tx => {
						await this.lock(tx, stageLock(key));
						const st = await tx.siteIdentityState.findUnique({ where: { key }, include: { activeAsset: { select: { sha256: true, version: true } } } });
						if (st?.activeAsset?.sha256 === v.sha256) throw new AppError('الملف مطابق تمامًا للنسخة المعتمدة حاليًا لهذا العنصر.', 409, undefined, SITE_IDENTITY_ERRORS.NO_CHANGE);
						if ((await tx.siteIdentityAsset.count({ where: { key, status: 'STAGED' } })) >= MAX_STAGED_PER_KEY) throw new AppError(`لهذا العنصر ${MAX_STAGED_PER_KEY} مسودات غير معتمدة؛ اعتمد إحداها أو احذفها قبل رفع مسودة جديدة.`, 409, undefined, SITE_IDENTITY_ERRORS.TOO_MANY_STAGED);
						const max = await tx.siteIdentityAsset.aggregate({ where: { key }, _max: { version: true } });
						const row = await tx.siteIdentityAsset.create({ data: { key, version: (max._max.version ?? 0) + 1, status: 'STAGED', mime: v.mime, bytes: Uint8Array.from(v.bytes), sha256: v.sha256, width: v.width, height: v.height, byteSize: v.byteSize, note: v.note, createdById: actorId }, select: META });
						await accountAuditLogService.record({ userId: actorId, eventType: 'SITE_IDENTITY_UPLOADED', category: LogCategory.SYSTEM_AUDIT, source: 'ADMIN', severity: 'INFO', title: 'رفع نسخة جديدة من هوية الموقع',
							summary: `رفع مسودة ${def.label} (نسخة ${row.version}) بانتظار الاعتماد`, details: { identityKey: key, version: row.version, sha: short(v.sha256), mime: v.mime, byteSize: v.byteSize, sanitizedRemoved: v.sanitized.removed, ...(def.kind === 'json' ? { tokenNames: Object.keys(JSON.parse(v.bytes.toString('utf8'))).join(' ').slice(0, 480) } : {}) },
							context: { ipAddress: ctx.ip, device: ctx.device, actorLabel: 'ADMIN' } }, tx);
						return { ...(await withActors(tx, assetOut(row as AssetMeta))), sanitized: v.sanitized, current: await this.keyState(tx, key) };
					});
				} catch (e) { if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002' && retries++ < 3) continue; throw e; }
			}
		});
	}

	// ------------------------------------------------------------------------------------------------------------------ discard
	async discard(key: string, versionId: string, actorId: string, ctx: AuditCtx = {}) {
		const def = this.def(key); if (!UUID_RE.test(String(versionId))) throw new AppError('معرّف النسخة غير صالح.', 400, undefined, SITE_IDENTITY_ERRORS.VERSION_NOT_FOUND);
		return this.guard(() => this.db.$transaction(async tx => {
			await this.lock(tx, stageLock(key));
			const a = await tx.siteIdentityAsset.findFirst({ where: { id: String(versionId), key }, select: META });
			if (!a) throw new AppError('النسخة غير موجودة.', 404, undefined, SITE_IDENTITY_ERRORS.VERSION_NOT_FOUND);
			if (a.status !== 'STAGED') throw new AppError('يمكن حذف المسودات غير المعتمدة فقط؛ النسخ المعتمدة وما سبقها تبقى محفوظة للتراجع.', 409, undefined, SITE_IDENTITY_ERRORS.NOT_STAGED);
			const row = await tx.siteIdentityAsset.update({ where: { id: a.id }, data: { status: 'DISCARDED', bytes: null }, select: META });
			await accountAuditLogService.record({ userId: actorId, eventType: 'SITE_IDENTITY_DISCARDED', category: LogCategory.SYSTEM_AUDIT, source: 'ADMIN', severity: 'INFO', title: 'حذف مسودة هوية',
				summary: `حذف مسودة ${def.label} (نسخة ${a.version}) قبل اعتمادها`, details: { identityKey: key, version: a.version, sha: short(a.sha256) }, context: { ipAddress: ctx.ip, device: ctx.device, actorLabel: 'ADMIN' } }, tx);
			return { ...(await withActors(tx, assetOut(row as AssetMeta))), current: await this.keyState(tx, key) };
		}));
	}

	// ------------------------------------------------------------------------------------------------------------------ the one mutation path
	/**
	 * Applies a set of {key -> asset | null} changes atomically: demote the old active rows, promote the new ones, bump each key's state version, write ONE manifest row and the audit row, then READ BACK
	 * (inside the transaction) the bytes of every newly active asset and the rows just written. Any throw rolls everything back.
	 */
	private async applyChanges(tx: Tx, changes: Array<{ key: string; toAssetId: string | null }>, actorId: string, reason: string, audit: (applied: Applied[]) => Parameters<typeof accountAuditLogService.record>[0]): Promise<{ manifestVersion: number; applied: Applied[] }> {
		const applied: Applied[] = [];
		const states = new Map((await tx.siteIdentityState.findMany({ where: { key: { in: changes.map(c => c.key) } } })).map(s => [s.key, s]));
		const ids = [...new Set([...changes.map(c => c.toAssetId), ...[...states.values()].map(s => s.activeAssetId)].filter((x): x is string => !!x))];
		const assets = new Map((await tx.siteIdentityAsset.findMany({ where: { id: { in: ids } }, select: META })).map(a => [a.id, a as AssetMeta]));
		// 1. demote
		for (const c of changes) { const old = states.get(c.key)?.activeAssetId; if (old) await tx.siteIdentityAsset.update({ where: { id: old }, data: { status: 'SUPERSEDED' } }); }
		// 2. promote + state
		const now = new Date();
		for (const c of changes) {
			const st = states.get(c.key); const oldId = st?.activeAssetId ?? null; const next = (st?.version ?? 0) + 1;
			if (c.toAssetId) await tx.siteIdentityAsset.update({ where: { id: c.toAssetId }, data: { status: 'PUBLISHED' } });
			await tx.siteIdentityState.upsert({ where: { key: c.key }, create: { key: c.key, activeAssetId: c.toAssetId, version: next, updatedAt: now, updatedById: actorId }, update: { activeAssetId: c.toAssetId, version: next, updatedAt: now, updatedById: actorId } });
			applied.push({ key: c.key, fromAssetId: oldId, toAssetId: c.toAssetId, from: oldId ? assets.get(oldId) ?? null : null, to: c.toAssetId ? assets.get(c.toAssetId) ?? null : null, stateVersion: next });
		}
		await this.faults.insideTx?.(tx, 'after-state');
		// 3. manifest row = the full state after this change
		const all = await tx.siteIdentityState.findMany({ select: { key: true, activeAssetId: true } });
		const snapshot: Record<string, string | null> = Object.fromEntries(all.sort((a, b) => a.key.localeCompare(b.key)).map(s => [s.key, s.activeAssetId]));
		const max = await tx.siteIdentityManifest.aggregate({ _max: { version: true } });
		const manifestVersion = (max._max.version ?? 0) + 1;
		await tx.siteIdentityManifest.create({ data: { version: manifestVersion, snapshot: snapshot as Prisma.InputJsonValue, createdById: actorId, reason: reason.slice(0, 300) } });
		await this.faults.insideTx?.(tx, 'after-manifest');
		const rec = audit(applied);
		const tokenNames = await this.tokenNamesOf(tx, applied);
		await accountAuditLogService.record(tokenNames ? { ...rec, details: { ...(rec.details as object), tokenNames } } : rec, tx);
		await this.faults.insideTx?.(tx, 'after-audit');
		// 4. read back INSIDE the transaction: what is about to be committed must be what the caller asked for, byte for byte
		for (const a of applied) {
			const st = await tx.siteIdentityState.findUnique({ where: { key: a.key } });
			if (!st || st.activeAssetId !== a.toAssetId || st.version !== a.stateVersion) throw verifyFailed(`state of ${a.key}`);
			if (a.toAssetId) {
				const row = await tx.siteIdentityAsset.findUnique({ where: { id: a.toAssetId }, select: { bytes: true, sha256: true, status: true, byteSize: true } });
				if (!row || row.status !== 'PUBLISHED' || !row.bytes) throw verifyFailed(`asset of ${a.key}`);
				const seen = this.faults.readBack ? this.faults.readBack({ bytes: row.bytes, sha256: row.sha256 }) : { bytes: row.bytes, sha256: row.sha256 };
				if (!seen.bytes || sha256Of(seen.bytes) !== seen.sha256 || seen.sha256 !== a.to?.sha256 || seen.bytes.length !== row.byteSize) throw verifyFailed(`bytes of ${a.key}`);
			}
		}
		const man = await tx.siteIdentityManifest.findUnique({ where: { version: manifestVersion } });
		const ms = man?.snapshot as Record<string, string | null> | undefined;
		if (!ms || applied.some(a => (ms[a.key] ?? null) !== a.toAssetId)) throw verifyFailed('manifest row');
		return { manifestVersion, applied };
	}

	/** audit detail for token keys: which override NAMES the new active sets hold (never the values) */
	private async tokenNamesOf(tx: Tx, applied: Applied[]): Promise<string> {
		const ts = applied.filter(a => isTokenKey(a.key)); if (!ts.length) return '';
		const parts: string[] = [];
		for (const a of ts) {
			let names: string[] = [];
			if (a.toAssetId) { const r = await tx.siteIdentityAsset.findUnique({ where: { id: a.toAssetId }, select: { bytes: true } }); try { names = r?.bytes ? Object.keys(validateTokenBytes(a.key, r.bytes, { allowEmpty: true }).value) : []; } catch { names = []; } }
			parts.push(`${a.key}=[${names.join(' ')}]`);
		}
		return parts.join('; ').slice(0, 480);
	}

	/** AFTER the commit: read the result again through a fresh query; false = what is stored is not what was committed */
	private async verifyCommitted(applied: Applied[], manifestVersion: number): Promise<boolean> {
		try {
			await this.faults.postCommit?.();
			for (const a of applied) {
				const st = await this.db.siteIdentityState.findUnique({ where: { key: a.key } });
				if (!st || st.activeAssetId !== a.toAssetId || st.version < a.stateVersion) return false;
				if (a.toAssetId) { const r = await this.db.siteIdentityAsset.findUnique({ where: { id: a.toAssetId }, select: { bytes: true, sha256: true } }); if (!r?.bytes || sha256Of(r.bytes) !== r.sha256 || r.sha256 !== a.to?.sha256) return false; }
			}
			const m = await this.db.siteIdentityManifest.findUnique({ where: { version: manifestVersion } });
			return !!m;
		} catch (e) { logger.error(`[SiteIdentity] post-commit verification could not run: ${(e as Error)?.message ?? e}`); return false; }
	}

	/** compensating transaction when the post-commit verification failed: put every touched key back (only if nobody changed it since) */
	private async revert(applied: Applied[], actorId: string, ctx: AuditCtx): Promise<void> {
		try {
			await this.db.$transaction(async tx => {
				await this.lock(tx, LOCK_NAME);
				const back: Array<{ key: string; toAssetId: string | null }> = [];
				for (const a of applied) { const st = await tx.siteIdentityState.findUnique({ where: { key: a.key } }); if (st && st.version === a.stateVersion) back.push({ key: a.key, toAssetId: a.fromAssetId }); }
				if (!back.length) return;
				await this.applyChanges(tx, back, actorId, `auto-revert: post-commit verification failed for ${back.map(b => b.key).join(',')}`, () => ({ userId: actorId, eventType: 'SITE_IDENTITY_RESTORED', category: LogCategory.SYSTEM_AUDIT, source: 'ADMIN', severity: 'WARNING',
					title: 'تراجع تلقائي عن تغيير هوية', summary: 'فشل التحقق بعد الحفظ فأُعيدت الهوية إلى حالتها السابقة تلقائيًا', details: { identityKey: back.map(b => b.key).join(','), target: 'auto-revert' }, context: { ipAddress: ctx.ip, device: ctx.device, actorLabel: 'ADMIN' } }));
			});
		} catch (e) { logger.error(`[SiteIdentity] automatic revert failed: ${(e as Error)?.message ?? e}`); }
	}

	private async run(actorId: string, ctx: AuditCtx, work: (tx: Tx) => Promise<{ manifestVersion: number; applied: Applied[] }>, result: (r: { manifestVersion: number; applied: Applied[] }) => Promise<unknown>) {
		const done = await this.guard(() => this.db.$transaction(async tx => { await this.lock(tx, LOCK_NAME); return work(tx); }, { timeout: 20_000, maxWait: 20_000 }));
		const touchesCache = done.applied.some(a => a.key === EMAIL_LOGO_KEY);
		if (!(await this.verifyCommitted(done.applied, done.manifestVersion))) {
			await this.revert(done.applied, actorId, ctx);
			if (touchesCache) await refreshSiteIdentityCache();
			throw new AppError('تم الحفظ لكن تعذّر التحقق من النتيجة بعد الحفظ، فأُعيدت الهوية إلى حالتها السابقة. لم يتغيّر شيء على الموقع. أعد المحاولة.', 500, undefined, SITE_IDENTITY_ERRORS.VERIFY_FAILED);
		}
		if (touchesCache) await refreshSiteIdentityCache(); // the synchronous e-mail shell sees the new logo from the next mail on (this process); other instances follow within the cache TTL
		return result(done);
	}

	/** publish / restore result: the new key state + everything the confirmation text needs (label, usages, from -> to version; 0 = the built-in default) */
	private async keyResult(def: SiteIdentityKeyDef, r: { manifestVersion: number; applied: Applied[] }) {
		const a = r.applied[0];
		return withActors(this.db, { ...(await this.keyState(this.db, def.key)), manifestVersion: r.manifestVersion, label: def.label, usages: def.usages, fromVersion: a.from?.version ?? 0, toVersion: a.to?.version ?? 0,
			previous: a.from ? assetOut({ ...a.from, status: 'SUPERSEDED' }) : null });
	}

	private checkVersion(expected: unknown, field = 'expectedVersion'): number {
		if (!Number.isInteger(expected) || (expected as number) < 0) throw fieldError(field, 'رقم النسخة المتوقعة (expectedVersion) مطلوب وهو عدد صحيح.');
		return expected as number;
	}

	// ------------------------------------------------------------------------------------------------------------------ publish
	async publish(key: string, body: { versionId?: unknown; expectedVersion?: unknown; note?: unknown }, actorId: string, ctx: AuditCtx = {}) {
		const def = this.writable(key); const expected = this.checkVersion(body.expectedVersion);
		if (typeof body.versionId !== 'string' || !UUID_RE.test(body.versionId)) throw fieldError('versionId', 'معرّف المسودة (versionId) مطلوب.');
		const versionId = body.versionId; const note = typeof body.note === 'string' ? body.note.replace(/[\u0000-\u001F\u007F]/g, ' ').trim().slice(0, 140) : '';
		return this.run(actorId, ctx, async tx => {
			const st = await tx.siteIdentityState.findUnique({ where: { key } });
			if ((st?.version ?? 0) !== expected) throw new SiteIdentityConflict('تغيّر هذا العنصر من جهة أخرى بعد أن فتحت الصفحة. راجع الحالة الحالية ثم أعد المحاولة.', await this.keyState(tx, key));
			const a = await tx.siteIdentityAsset.findFirst({ where: { id: versionId, key }, select: META });
			if (!a) throw new AppError('المسودة غير موجودة.', 404, undefined, SITE_IDENTITY_ERRORS.VERSION_NOT_FOUND);
			if (a.status !== 'STAGED') throw new AppError('لا يمكن اعتماد هذه النسخة: ليست مسودة. للعودة إلى نسخة سابقة استخدم «استعادة».', 409, undefined, SITE_IDENTITY_ERRORS.NOT_STAGED);
			// you apply what YOU previewed: a draft uploaded by another admin is theirs to apply (the stored row is activated as it is; nobody publishes a file they did not upload and look at)
			if (a.createdById !== actorId) throw new AppError('هذه المسودة رفعها مشرف آخر؛ يعتمدها من رفعها بعد معاينتها. يمكنك معاينتها أو حذفها فقط.', 409, undefined, SITE_IDENTITY_ERRORS.DRAFT_NOT_YOURS);
			return this.applyChanges(tx, [{ key, toAssetId: a.id }], actorId, `publish ${key} v${a.version}${note ? ` | ${note}` : ''}`, (applied) => ({ userId: actorId, eventType: 'SITE_IDENTITY_PUBLISHED', category: LogCategory.SYSTEM_AUDIT, source: 'ADMIN', severity: 'WARNING',
				title: 'اعتماد نسخة جديدة من هوية الموقع', summary: `اعتماد ${def.label}: من ${applied[0].from ? `نسخة ${applied[0].from.version}` : 'الافتراضي'} إلى نسخة ${a.version}`,
				details: { identityKey: key, fromVersion: applied[0].from?.version ?? 0, toVersion: a.version, fromSha: applied[0].from ? short(applied[0].from.sha256) : 'default', toSha: short(a.sha256), stateVersion: applied[0].stateVersion }, context: { ipAddress: ctx.ip, device: ctx.device, actorLabel: 'ADMIN' } }));
		}, r => this.keyResult(def, r));
	}

	// ------------------------------------------------------------------------------------------------------------------ restore one key
	async restore(key: string, body: { target?: unknown; expectedVersion?: unknown }, actorId: string, ctx: AuditCtx = {}) {
		const def = this.writable(key); const expected = this.checkVersion(body.expectedVersion);
		const target = body.target;
		if (target !== 'default' && !(typeof target === 'string' && UUID_RE.test(target))) throw fieldError('target', 'الهدف (target) إما معرّف نسخة سابقة أو الكلمة default.');
		return this.run(actorId, ctx, async tx => {
			const st = await tx.siteIdentityState.findUnique({ where: { key } });
			if ((st?.version ?? 0) !== expected) throw new SiteIdentityConflict('تغيّر هذا العنصر من جهة أخرى بعد أن فتحت الصفحة. راجع الحالة الحالية ثم أعد المحاولة.', await this.keyState(tx, key));
			let toId: string | null = null; let to: AssetMeta | null = null;
			if (target !== 'default') {
				to = (await tx.siteIdentityAsset.findFirst({ where: { id: target as string, key }, select: META })) as AssetMeta | null;
				if (!to) throw new AppError('النسخة غير موجودة.', 404, undefined, SITE_IDENTITY_ERRORS.VERSION_NOT_FOUND);
				if (to.status !== 'PUBLISHED' && to.status !== 'SUPERSEDED') throw new AppError('يمكن الاستعادة إلى نسخة سبق اعتمادها فقط. المسودات تُعتمد بزر «اعتماد».', 409, undefined, SITE_IDENTITY_ERRORS.NOT_RESTORABLE);
				toId = to.id;
			}
			if ((st?.activeAssetId ?? null) === toId) throw new AppError(toId ? 'هذه النسخة هي المعتمدة حاليًا.' : 'العنصر يعرض الأصل الافتراضي بالفعل.', 409, undefined, SITE_IDENTITY_ERRORS.NO_CHANGE);
			return this.applyChanges(tx, [{ key, toAssetId: toId }], actorId, `restore ${key} -> ${to ? `v${to.version}` : 'default'}`, (applied) => ({ userId: actorId, eventType: 'SITE_IDENTITY_RESTORED', category: LogCategory.SYSTEM_AUDIT, source: 'ADMIN', severity: 'WARNING',
				title: 'استعادة نسخة سابقة من هوية الموقع', summary: `استعادة ${def.label}: من ${applied[0].from ? `نسخة ${applied[0].from.version}` : 'الافتراضي'} إلى ${to ? `نسخة ${to.version}` : 'الأصل الافتراضي'}`,
				details: { identityKey: key, fromVersion: applied[0].from?.version ?? 0, toVersion: to?.version ?? 0, fromSha: applied[0].from ? short(applied[0].from.sha256) : 'default', toSha: to ? short(to.sha256) : 'default', target: to ? 'version' : 'default', stateVersion: applied[0].stateVersion }, context: { ipAddress: ctx.ip, device: ctx.device, actorLabel: 'ADMIN' } }));
		}, r => this.keyResult(def, r));
	}

	// ------------------------------------------------------------------------------------------------------------------ restore a whole manifest snapshot
	private side(def: SiteIdentityKeyDef, a: AssetMeta | null): SetSide {
		if (!a) return { source: 'default', versionId: null, version: 0, sha256: def.defaultFingerprint.sha256, mime: def.defaultFingerprint.mime, width: def.defaultFingerprint.width ?? null, height: def.defaultFingerprint.height ?? null, previewUrl: null };
		return { source: 'custom', versionId: a.id, version: a.version, sha256: a.sha256, mime: a.mime, width: a.width, height: a.height, previewUrl: `/admin/site-identity/${a.key}/versions/${a.id}/preview` };
	}

	/**
	 * The EXACT diff between the live identity and manifest `targetVersion` (0 = every key back to its built-in default), for every WIRED key, plus the digest that binds a later apply to this very diff.
	 * Used read-only by the preview route and again, inside the locked transaction, by the apply (so the two can never disagree). Refuses what the apply would refuse (unknown manifest, an unwired key
	 * that would change, a target version that is no longer restorable).
	 */
	private async setDiff(db: Tx, targetVersion: number) {
		const mv = await db.siteIdentityManifest.aggregate({ _max: { version: true } }); const current = mv._max.version ?? 0;
		let snap: Record<string, string | null> = {};
		if (targetVersion > 0) {
			const row = await db.siteIdentityManifest.findUnique({ where: { version: targetVersion } });
			if (!row) throw new AppError('نسخة المجموعة المطلوبة غير موجودة.', 404, undefined, SITE_IDENTITY_ERRORS.MANIFEST_NOT_FOUND);
			snap = row.snapshot as Record<string, string | null>;
		}
		const states = new Map((await db.siteIdentityState.findMany()).map(s => [s.key, s.activeAssetId]));
		const ids = [...new Set([...states.values(), ...Object.values(snap)].filter((x): x is string => !!x))];
		const metas = new Map(((ids.length ? await db.siteIdentityAsset.findMany({ where: { id: { in: ids } }, select: META }) : []) as AssetMeta[]).map(a => [a.id, a]));
		const items: SetPreviewItem[] = []; const changes: Array<{ key: string; toAssetId: string | null }> = [];
		for (const d of SITE_IDENTITY_REGISTRY) {
			const want = snap[d.key] ?? null; const have = states.get(d.key) ?? null; const wired = this.isWired(d.key);
			if (want !== have) {
				if (!wired) throw new AppError(`لا يمكن الاستعادة: العنصر ${d.key} غير مرتبط بالموقع بعد.`, 409, undefined, SITE_IDENTITY_ERRORS.NOT_WIRED);
				if (want) { const a = metas.get(want); if (!a || a.key !== d.key || (a.status !== 'PUBLISHED' && a.status !== 'SUPERSEDED')) throw new AppError(`تعذّرت الاستعادة: نسخة العنصر ${d.key} في تلك المجموعة غير متاحة.`, 409, undefined, SITE_IDENTITY_ERRORS.NOT_RESTORABLE); }
				changes.push({ key: d.key, toAssetId: want });
			}
			if (!wired) continue;
			const cur = have ? metas.get(have) ?? null : null; const tgt = want ? metas.get(want) ?? null : null;
			items.push({ key: d.key, label: d.label, group: d.group, current: this.side(d, cur), target: this.side(d, tgt), change: want === have ? 'unchanged' : want ? 'replace' : 'to-default' });
		}
		const digest = createHash('sha256').update(JSON.stringify({ c: current, t: targetVersion, k: items.map(i => [i.key, i.current.version, i.current.sha256, i.target.version, i.target.sha256]) })).digest('hex');
		const preview = { currentManifestVersion: current, targetManifestVersion: targetVersion, previewDigest: digest, changedCount: changes.length, canApply: changes.length > 0, items };
		return { preview, changes };
	}

	/** GET /restore-set/:manifestVersion/preview - read-only, one consistent snapshot */
	async previewRestoreSet(manifestVersion: unknown) {
		const n = typeof manifestVersion === 'string' && /^\d{1,9}$/.test(manifestVersion) ? Number(manifestVersion) : typeof manifestVersion === 'number' ? manifestVersion : NaN;
		if (!Number.isInteger(n) || n < 0) throw fieldError('manifestVersion', 'رقم نسخة المجموعة (manifestVersion) عدد صحيح ≥ 0 (0 = كل العناصر الافتراضية).');
		return this.guard(() => this.db.$transaction(async tx => withValues(tx, (await this.setDiff(tx, n)).preview), { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead }));
	}

	async restoreSet(body: { manifestVersion?: unknown; expectedManifestVersion?: unknown; previewDigest?: unknown }, actorId: string, ctx: AuditCtx = {}) {
		const target = body.manifestVersion;
		if (!Number.isInteger(target) || (target as number) < 0) throw fieldError('manifestVersion', 'رقم نسخة المجموعة (manifestVersion) مطلوب (0 = كل العناصر الافتراضية).');
		const expected = this.checkVersion(body.expectedManifestVersion, 'expectedManifestVersion'); const targetVersion = target as number;
		if (typeof body.previewDigest !== 'string' || !SHA_RE.test(body.previewDigest)) throw fieldError('previewDigest', 'بصمة المعاينة (previewDigest) مطلوبة: عاين الاستعادة أولًا ثم أرسل البصمة كما وصلتك.');
		const digest = body.previewDigest;
		return this.run(actorId, ctx, async tx => {
			const diff = await this.setDiff(tx, targetVersion);
			// what is about to be applied must be EXACTLY what the admin was shown: anything that moved since (a publish, a restore, a changed target) gives a fresh preview and changes nothing
			if (diff.preview.previewDigest !== digest) throw new SiteIdentityConflict('تغيّرت الهوية منذ أن عاينت الاستعادة، فلم يُطبَّق شيء. راجع المعاينة المحدّثة ثم أعد المحاولة.', await withValues(tx, diff.preview), SITE_IDENTITY_ERRORS.PREVIEW_STALE);
			if (diff.preview.currentManifestVersion !== expected) throw new SiteIdentityConflict('تغيّرت هوية الموقع من جهة أخرى بعد أن فتحت الصفحة. راجع الحالة الحالية ثم أعد المحاولة.', await this.fullState(tx));
			const changes = diff.changes;
			if (!changes.length) throw new AppError('الهوية الحالية مطابقة لتلك المجموعة؛ لا يوجد ما يُستعاد.', 409, undefined, SITE_IDENTITY_ERRORS.NO_CHANGE);
			return this.applyChanges(tx, changes, actorId, `restore-set -> manifest ${targetVersion}`, (applied) => ({ userId: actorId, eventType: 'SITE_IDENTITY_SET_RESTORED', category: LogCategory.SYSTEM_AUDIT, source: 'ADMIN', severity: 'WARNING',
				title: 'استعادة مجموعة هوية كاملة', summary: `استعادة مجموعة الهوية رقم ${targetVersion}: تغيّر ${applied.length} عنصر`,
				details: { identityKey: applied.map(a => a.key).join(','), target: `manifest ${targetVersion}`, manifestTarget: targetVersion, changes: applied.map(a => `${a.key}:${a.from ? `v${a.from.version}` : 'default'}>${a.to ? `v${a.to.version}` : 'default'}`).join(' ') }, context: { ipAddress: ctx.ip, device: ctx.device, actorLabel: 'ADMIN' } }));
		}, async r => ({ ...(await this.fullState(this.db)), manifestVersion: r.manifestVersion, changedKeys: r.applied.map(a => a.key) }));
	}
}

export interface PublicManifest { version: number; items: Record<string, { url: string; sha256: string; mime: string; width: number | null; height: number | null; version: number; /** design-token keys only */ value?: Record<string, string> }>; /** present only when at least one token set is active */ tokensCss?: string }
export interface SetSide { source: 'default' | 'custom'; versionId: string | null; version: number; sha256: string; mime: string; width: number | null; height: number | null; previewUrl: string | null }
export interface SetPreviewItem { key: string; label: string; group: string; current: SetSide; target: SetSide; change: 'replace' | 'to-default' | 'unchanged' }

interface Applied { key: string; fromAssetId: string | null; toAssetId: string | null; from: AssetMeta | null; to: AssetMeta | null; stateVersion: number }
const verifyFailed = (what: string) => new AppError(`فشل التحقق من سلامة الحفظ (${what}); لم يُغيَّر شيء.`, 500, undefined, SITE_IDENTITY_ERRORS.VERIFY_FAILED);

export const siteIdentityService = new SiteIdentityService();
registerSiteIdentityCacheLoader(async () => {
	const st = await defaultPrisma.siteIdentityState.findUnique({ where: { key: EMAIL_LOGO_KEY }, include: { activeAsset: { select: { sha256: true, status: true } } } });
	const a = st?.activeAsset; return a && (a.status === 'PUBLISHED' || a.status === 'SUPERSEDED') ? a.sha256 : null;
});
