import { z } from 'zod';
import { prisma } from '../config/db';
import { AppError, fieldErrors } from '../utils/app-error';
import { withTableGuard, isMissingTableError } from '../utils/missing-table';

const text = (max: number) => z.string().trim().max(max);
const optionalPhone = text(30).regex(/^[0-9+()\-\s]*$/, 'رقم الهاتف غير صالح');

/** Whitelist of settings. `public` keys are also served by GET /public/settings. Nothing else can be stored. */
export const SETTING_DEFS = {
	platformName: { public: true, schema: text(80).min(1, 'اسم المنصة مطلوب'), default: '' },
	supportEmail: { public: true, schema: z.union([z.literal(''), z.string().trim().email('البريد غير صالح').max(120)]), default: '' },
	supportPhone: { public: true, schema: optionalPhone, default: '' },
	maintenanceBannerEnabled: { public: true, schema: z.boolean(), default: false },
	maintenanceBannerText: { public: true, schema: text(300), default: '' },
	termsVersion: { public: true, schema: text(40), default: '' },
	privacyVersion: { public: true, schema: text(40), default: '' },
	termsContent: { public: true, schema: text(60000), default: '' },
	privacyContent: { public: true, schema: text(60000), default: '' },
	adminNotificationEmail: { public: false, schema: z.union([z.literal(''), z.string().trim().email('البريد غير صالح').max(120)]), default: '' }
} as const;

export type SettingKey = keyof typeof SETTING_DEFS;
export const SETTING_KEYS = Object.keys(SETTING_DEFS) as SettingKey[];
export type SettingsMap = Record<SettingKey, string | boolean>;

const PUBLIC_KEYS = SETTING_KEYS.filter(k => SETTING_DEFS[k].public);

function withDefaults(rows: Array<{ key: string; value: unknown }>, keys: SettingKey[]): Record<string, string | boolean> {
	const out: Record<string, string | boolean> = {};
	for (const k of keys) out[k] = SETTING_DEFS[k].default;
	for (const row of rows) {
		const def = SETTING_DEFS[row.key as SettingKey];
		if (!def || !keys.includes(row.key as SettingKey)) continue;
		const parsed = def.schema.safeParse(row.value);
		if (parsed.success) out[row.key] = parsed.data as string | boolean;
	}
	return out;
}

export class PlatformSettingsService {
	/** False while the platform_settings table has not been created yet: reads then answer the built-in defaults (200) and saving is refused with a clear 503. */
	async storageReady(): Promise<boolean> {
		try { await prisma.platformSetting.count(); return true; } catch (e) { if (isMissingTableError(e)) return false; throw e; }
	}

	private async rowsOrDefaults(args?: Parameters<typeof prisma.platformSetting.findMany>[0]) {
		try { return await prisma.platformSetting.findMany(args); } catch (e) { if (isMissingTableError(e)) return []; throw e; }
	}

	async getAll() {
		return withDefaults(await this.rowsOrDefaults(), SETTING_KEYS);
	}

	async getPublic() {
		return withDefaults(await this.rowsOrDefaults({ where: { key: { in: PUBLIC_KEYS } } }), PUBLIC_KEYS);
	}

	/** Validates a partial update against the whitelist; unknown keys are rejected. Returns the cleaned values. */
	validate(body: unknown): Record<string, string | boolean> {
		if (!body || typeof body !== 'object' || Array.isArray(body)) throw new AppError('صيغة الطلب غير صحيحة', 400);
		const clean: Record<string, string | boolean> = {};
		const errors: Array<{ field: string; message: string }> = [];
		for (const [key, value] of Object.entries(body as Record<string, unknown>)) {
			const def = SETTING_DEFS[key as SettingKey];
			if (!def || !Object.prototype.hasOwnProperty.call(SETTING_DEFS, key)) { errors.push({ field: key, message: `إعداد غير معروف: ${key}` }); continue; }
			const parsed = def.schema.safeParse(value);
			if (!parsed.success) errors.push({ field: key, message: parsed.error.issues[0]?.message || `قيمة غير صالحة: ${key}` });
			else clean[key] = parsed.data as string | boolean;
		}
		if (errors.length) throw fieldErrors(errors[0].message, errors);
		if (!Object.keys(clean).length) throw new AppError('لا توجد إعدادات للحفظ', 400);
		return clean;
	}

	/** Saves the cleaned values; returns the before/after of only the keys that really changed (empty = nothing changed). */
	async update(clean: Record<string, string | boolean>, adminId: string) {
		const before = await this.getAll();
		const changed = Object.keys(clean).filter(k => before[k as SettingKey] !== clean[k]);
		if (!changed.length) return { changed: [] as string[], before: {}, after: {}, settings: before };
		await withTableGuard(() => prisma.$transaction(changed.map(key => prisma.platformSetting.upsert({
			where: { key }, create: { key, value: clean[key], updatedBy: adminId }, update: { value: clean[key], updatedBy: adminId }
		}))), 'مخزن الإعدادات');
		const pick = (src: Record<string, unknown>) => Object.fromEntries(changed.map(k => [k, src[k]]));
		// long legal text is not copied whole into the audit entry
		const brief = (o: Record<string, unknown>) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, typeof v === 'string' && v.length > 200 ? `${v.slice(0, 200)}… (${v.length} حرف)` : v]));
		return { changed, before: brief(pick(before)), after: brief(pick(clean)), settings: { ...before, ...clean } };
	}

	async history(limit = 20) {
		const rows = await prisma.accountAuditLog.findMany({
			where: { eventType: 'PLATFORM_SETTINGS_UPDATED' }, orderBy: { occurredAt: 'desc' }, take: Math.min(Math.max(limit, 1), 50),
			select: { id: true, occurredAt: true, summary: true, ipAddress: true, afterData: true, user: { select: { firstName: true, lastName: true, email: true } } }
		});
		return rows.map(r => ({ id: r.id, at: r.occurredAt, summary: r.summary, ip: r.ipAddress, actor: [r.user?.firstName, r.user?.lastName].filter(Boolean).join(' ') || r.user?.email || null }));
	}
}

export const platformSettingsService = new PlatformSettingsService();
