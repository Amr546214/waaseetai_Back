import { LogCategory, LogStatus, Prisma } from '@prisma/client';
import { prisma as defaultPrisma } from '../config/db';
import { AppError, fieldError, fieldErrors } from '../utils/app-error';
import { isMissingTableError } from '../utils/missing-table';
import type { AdminActor } from './admin-access.service';
import { ENFORCED_KEYS, PUBLIC_KEYS, SETTINGS_CACHE_TTL_MS, SETTING_BY_KEY, SETTING_DEFS, SettingDef, SettingPerm } from '../config/system-settings.registry';
import { currencyReadiness } from './currency-readiness.service';
import { logger } from '../config/logger';
import { sessionService } from './session.service';
import { setBrandName } from '../utils/brand'; // used only inside functions: the cycle with session.service is harmless

export const SETTINGS_VERSION_CONFLICT = 'SETTINGS_VERSION_CONFLICT';
export const SETTING_NOT_AVAILABLE = 'SETTING_NOT_AVAILABLE';
export const CURRENCY_CHANGE_NOT_READY = 'CURRENCY_CHANGE_NOT_READY';
export const SETTING_PERMISSION_DENIED = 'SETTING_PERMISSION_DENIED';

export interface SettingsCtx { ip?: string; device?: string }
type Snapshot = { at: number; values: Map<string, { value: unknown; version: number }>; storage: boolean };
const brief = (v: unknown) => (typeof v === 'string' && v.length > 200 ? `${v.slice(0, 200)}… (${v.length} حرف)` : v);
const can = (actor: Pick<AdminActor, 'isSuperAdmin' | 'permissions'>, perm: SettingPerm) => actor.isSuperAdmin || (perm !== 'SUPER' && actor.permissions.has(perm));

/**
 * The server-side source of truth for platform settings: stored in `platform_settings` (key, JSON value, version), typed and bounded by the registry, saved with a version check,
 * in one transaction together with its audit entry. Reads are cached for SETTINGS_CACHE_TTL_MS and the cache is dropped on every local save (other instances catch up within that TTL).
 */
export class SystemSettingsService {
	private cache: Snapshot | null = null;
	constructor(private db: typeof defaultPrisma = defaultPrisma) {}

	invalidate() { this.cache = null; }

	private async snapshot(force = false): Promise<Snapshot> {
		if (!force && this.cache && Date.now() - this.cache.at < SETTINGS_CACHE_TTL_MS) return this.cache;
		const values = new Map<string, { value: unknown; version: number }>(); let storage = true;
		try {
			const rows = await this.db.platformSetting.findMany();
			for (const r of rows) values.set(r.key, { value: r.value, version: r.version });
		} catch (e) { if (isMissingTableError(e)) storage = false; else throw e; }
		this.cache = { at: Date.now(), values, storage };
		this.noteGood(this.cache);
		return this.cache;
	}

	/** every successful read refreshes the last KNOWN-GOOD value of every enforced key (what an outage falls back to - never a silent default) */
	private lastGood = new Map<string, { value: unknown; at: number }>();
	private lastFailLog = 0;
	private noteGood(s: Snapshot) {
		{ const row = s.values.get('platformName'); const p = row ? SETTING_BY_KEY.get('platformName')!.schema!.safeParse(row.value) : null; setBrandName(p && p.success ? p.data : ''); }
		for (const d of SETTING_DEFS) { if (d.status !== 'enforced' || !d.schema) continue; const row = s.values.get(d.key); const p = row ? d.schema.safeParse(row.value) : null; this.lastGood.set(d.key, { value: p && p.success ? p.data : d.default, at: s.at }); }
	}
	private logReadFailure(e: unknown) { if (Date.now() - this.lastFailLog > 60_000) { this.lastFailLog = Date.now(); logger.error(`[Settings] read failed, using last known good values where they exist: ${(e as Error)?.message ?? e}`); } }
	/** true once at least one read of the store has succeeded in this process (a "cold boot" without it has no trusted value) */
	hasTrustedValues(): boolean { return this.lastGood.size > 0; }
	/** warm the cache at boot; never throws */
	async prime(): Promise<boolean> { try { await this.snapshot(true); return true; } catch (e) { this.logReadFailure(e); return false; } }

	/**
	 * The value of an ENFORCED key with its trust. Order: the stored value (or the registry default when nothing is stored - the table being readable is what makes that default trustworthy);
	 * when the store cannot be read: the LAST KNOWN GOOD value of this process (logged, `stale`); with none (cold boot) the default but `trusted: false` so the caller applies its own boot policy.
	 */
	async getTrusted<T = unknown>(key: string): Promise<{ value: T; trusted: boolean; stale: boolean }> {
		const def = SETTING_BY_KEY.get(key);
		if (!def || def.status !== 'enforced' || !def.schema) throw new Error(`unknown enforced setting ${key}`);
		try {
			const s = await this.snapshot(); const row = s.values.get(key);
			if (row) { const p = def.schema.safeParse(row.value); if (p.success) return { value: p.data as T, trusted: true, stale: false }; }
			return { value: def.default as T, trusted: true, stale: false };
		} catch (e) {
			this.logReadFailure(e);
			const g = this.lastGood.get(key); if (g) return { value: g.value as T, trusted: true, stale: true };
			return { value: def.default as T, trusted: false, stale: false };
		}
	}
	/** typed value only (see getTrusted). Never throws: an enforcement point must not take the platform down. */
	async get<T = unknown>(key: string): Promise<T> { return (await this.getTrusted<T>(key)).value; }

	/** everything the actor may READ: enforced keys with value + version, read-only/blocked entries with their reason. */
	async view(actor: AdminActor) {
		const s = await this.snapshot(true);
		const items = SETTING_DEFS.filter(d => this.mayRead(actor, d)).map(d => {
			const base = { key: d.key, tab: d.tab, label: d.label, description: d.description, status: d.status, unit: d.unit ?? null, allowed: d.allowed ?? null, allowedLabels: d.labels ?? null, pages: d.pages, canWrite: d.status === 'enforced' && can(actor, d.write), effect: d.effect ?? null, reason: d.reason ?? null };
			if (d.status === 'enforced') { const row = s.values.get(d.key); const p = row && d.schema!.safeParse(row.value); return { ...base, value: p && p.success ? p.data : d.default, version: row?.version ?? 0, source: row ? 'stored' : 'default' }; }
			if (d.status === 'readonly' && d.current) { const c = d.current(); return { ...base, value: c.value, version: null, source: c.source }; }
			return { ...base, value: null, version: null, source: null };
		});
		return { storageReady: s.storage, items };
	}

	async publicValues() {
		const out: Record<string, unknown> = {};
		for (const k of PUBLIC_KEYS) out[k] = await this.get(k);
		return out;
	}

	async update(actor: AdminActor, body: unknown, ctx: SettingsCtx = {}) {
		const b = body && typeof body === 'object' && !Array.isArray(body) ? body as Record<string, unknown> : null;
		if (!b || Object.keys(b).some(k => k !== 'changes' && k !== 'expected')) throw new AppError('صيغة الطلب غير صحيحة', 400);
		const changes = b.changes && typeof b.changes === 'object' && !Array.isArray(b.changes) ? b.changes as Record<string, unknown> : null;
		const expected = b.expected && typeof b.expected === 'object' && !Array.isArray(b.expected) ? b.expected as Record<string, unknown> : {};
		if (!changes || !Object.keys(changes).length) throw new AppError('لا توجد إعدادات للحفظ', 400);
		const clean = new Map<string, unknown>(); const errors: Array<{ field: string; message: string }> = [];
		for (const [key, value] of Object.entries(changes)) {
			const def = SETTING_BY_KEY.get(key);
			if (!def) { errors.push({ field: key, message: `إعداد غير معروف: ${key}` }); continue; }
			if (def.status !== 'enforced' || !def.schema) throw new AppError(`هذا الإعداد غير متاح للتعديل: ${def.reason ?? ''}`.trim(), 422, [{ key, reason: def.reason ?? null }], SETTING_NOT_AVAILABLE);
			if (!can(actor, def.write)) throw new AppError('ليست لديك صلاحية تعديل هذا الإعداد', 403, [{ key }], SETTING_PERMISSION_DENIED);
			const p = def.schema.safeParse(value);
			if (!p.success) errors.push({ field: key, message: p.error.issues[0]?.message || 'قيمة غير صالحة' }); else clean.set(key, p.data);
			if (!Number.isInteger(expected[key])) errors.push({ field: key, message: 'رقم نسخة الإعداد مطلوب لمنع استبدال تعديل أحدث' });
		}
		if (errors.length) throw fieldErrors(errors[0].message, errors);

		const before = await this.snapshot(true);
		if (!before.storage) throw new AppError('مخزن الإعدادات غير جاهز بعد على الخادم', 503);
		const changed = [...clean.keys()].filter(k => JSON.stringify(this.effective(before, k)) !== JSON.stringify(clean.get(k)));
		for (const k of [...clean.keys()]) if ((before.values.get(k)?.version ?? 0) !== expected[k]) throw new AppError('عُدّل هذا الإعداد من جهة أخرى قبل حفظك. أعد التحميل وراجع التغيير.', 409, [{ key: k, current: this.view1(before, k) }], SETTINGS_VERSION_CONFLICT);
		if (!changed.length) return { changed: [] as string[], items: (await this.view(actor)).items };
		if (changed.includes('baseCurrency')) {
			const r = await currencyReadiness(this.db);
			if (!r.ready) throw new AppError('تغيير العملة الأساسية غير جاهز: البنية الحالية لا تدعم أكثر من عملة بأمان.', 409, r.blockers, CURRENCY_CHANGE_NOT_READY);
		}
		const beforeVals = Object.fromEntries(changed.map(k => [k, brief(this.effective(before, k))]));
		const afterVals = Object.fromEntries(changed.map(k => [k, brief(clean.get(k))]));
		try {
			await this.db.$transaction(async tx => {
				for (const k of changed) {
					const cur = before.values.get(k);
					if (cur) { const r = await tx.platformSetting.updateMany({ where: { key: k, version: cur.version }, data: { value: clean.get(k) as Prisma.InputJsonValue, version: { increment: 1 }, updatedBy: actor.userId } }); if (r.count === 0) throw new AppError('عُدّل هذا الإعداد من جهة أخرى قبل حفظك. أعد التحميل وراجع التغيير.', 409, [{ key: k }], SETTINGS_VERSION_CONFLICT); }
					else await tx.platformSetting.create({ data: { key: k, value: clean.get(k) as Prisma.InputJsonValue, version: 1, updatedBy: actor.userId } });
				}
				await tx.accountAuditLog.create({ data: {
					userId: actor.userId, category: LogCategory.SYSTEM_AUDIT, title: 'تعديل إعدادات المنصة', actionText: `تعديل إعدادات المنصة: ${changed.join('، ')}`, summary: `تعديل إعدادات المنصة: ${changed.join('، ')}`,
					eventType: 'PLATFORM_SETTINGS_UPDATED', source: 'ADMIN', severity: changed.some(k => SETTING_BY_KEY.get(k)!.write === 'SUPER') ? 'WARNING' : 'INFO', status: LogStatus.COMPLETED, actorLabel: 'ADMIN',
					beforeData: beforeVals as Prisma.InputJsonValue, afterData: afterVals as Prisma.InputJsonValue, metaData: { keys: changed } as Prisma.InputJsonValue, ipAddress: ctx.ip?.slice(0, 80), device: ctx.device?.slice(0, 120),
				} });
			});
		} catch (e) {
			if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') throw new AppError('عُدّل هذا الإعداد من جهة أخرى قبل حفظك. أعد التحميل وراجع التغيير.', 409, undefined, SETTINGS_VERSION_CONFLICT);
			throw e;
		}
		this.invalidate();
		return { changed, items: (await this.view(actor)).items };
	}

	/** may read: the read permission, or the permission that lets them change it (changing something you cannot see makes no sense) */
	private mayRead(actor: AdminActor, d: SettingDef) { return can(actor, d.read) || (d.write !== 'SUPER' && can(actor, d.write)); }
	private effective(s: Snapshot, key: string): unknown { const d = SETTING_BY_KEY.get(key)!; const row = s.values.get(key); if (row) { const p = d.schema!.safeParse(row.value); if (p.success) return p.data; } return d.default; }
	private view1(s: Snapshot, key: string) { return { value: this.effective(s, key), version: s.values.get(key)?.version ?? 0 }; }

	/** real change log (who, when, from which address, before → after); never contains secrets because none are stored here */
	async history(actor: AdminActor, limit = 20) {
		const rows = await this.db.accountAuditLog.findMany({ where: { eventType: 'PLATFORM_SETTINGS_UPDATED' }, orderBy: { occurredAt: 'desc' }, take: Math.min(Math.max(limit, 1), 100),
			select: { id: true, occurredAt: true, summary: true, ipAddress: true, beforeData: true, afterData: true, severity: true, user: { select: { firstName: true, lastName: true, email: true } } } });
		const visible = (k: string) => { const d = SETTING_BY_KEY.get(k); return !!d && this.mayRead(actor, d); };
		return rows.map(r => {
			const a = (r.afterData ?? {}) as Record<string, unknown>, bf = (r.beforeData ?? {}) as Record<string, unknown>;
			const keys = Object.keys(a).filter(visible);
			return { id: r.id, at: r.occurredAt, severity: r.severity, ip: r.ipAddress, actor: [r.user?.firstName, r.user?.lastName].filter(Boolean).join(' ') || r.user?.email || null,
				changes: keys.map(k => ({ key: k, label: SETTING_BY_KEY.get(k)!.label, from: bf[k] ?? null, to: a[k] ?? null })) };
		}).filter(r => r.changes.length > 0);
	}

	/** how many live sessions a given idle limit would end right now (shown in the confirmation before saving; SUPER_ADMIN only at the route) */
	async sessionsImpact(idleMinutes: unknown) {
		const n = Number(idleMinutes);
		const def = SETTING_BY_KEY.get('sessionIdleMinutes')!; const p = def.schema!.safeParse(n);
		if (!p.success) throw fieldError('idleMinutes', p.error.issues[0]?.message || 'قيمة غير صالحة');
		return { idleMinutes: n, ...(await sessionService.idleImpact(n)) };
	}

	/** real health facts only; anything without a real source is reported as unavailable with the reason */
	async health() {
		const t0 = Date.now(); let db = { ok: false as boolean, ms: null as number | null };
		try { await this.db.$queryRaw`SELECT 1`; db = { ok: true, ms: Date.now() - t0 }; } catch { db = { ok: false, ms: null }; }
		return {
			checkedAt: new Date().toISOString(),
			items: [
				{ key: 'app', label: 'خادم التطبيق', status: 'ok', detail: `يعمل منذ ${Math.floor(process.uptime() / 60)} دقيقة (عمر هذه العملية)` },
				{ key: 'database', label: 'قاعدة البيانات', status: db.ok ? 'ok' : 'down', detail: db.ok ? `استجابة ${db.ms} ms` : 'لا تستجيب' },
				{ key: 'paypal', label: 'بوابة الدفع (PayPal)', status: process.env.PAYPAL_CLIENT_ID && process.env.PAYPAL_CLIENT_SECRET ? 'configured' : 'unconfigured', detail: 'حالة التهيئة فقط، دون اتصال فعلي بالبوابة' },
				{ key: 'mail', label: 'خدمة البريد الإلكتروني', status: process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS ? 'configured' : 'unconfigured', detail: 'حالة التهيئة فقط، دون إرسال تجريبي' },
				{ key: 'ai', label: 'محرك AI', status: 'unavailable', detail: 'خارج نطاق هذه الصفحة (مراقبته نطاق منفصل)' },
				{ key: 'cdn', label: 'CDN وتسليم الملفات', status: 'unavailable', detail: 'لا يوجد مصدر مراقبة مرتبط' },
				{ key: 'backup', label: 'النسخ الاحتياطي', status: 'unavailable', detail: 'لا يوجد مصدر مراقبة مرتبط (النسخ تتم خارج التطبيق)' },
			],
		};
	}
}
export const systemSettingsService = new SystemSettingsService();
export { ENFORCED_KEYS };
