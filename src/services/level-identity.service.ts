import { LogCategory, LogStatus, Prisma } from '@prisma/client';
import { prisma as defaultPrisma } from '../config/db';
import { logger } from '../config/logger';
import { AppError, fieldError } from '../utils/app-error';
import { applyLevelOverrides, defaultLevelColor, defaultLevelName, levelOverrideOf, LEVELS_BY_ROLE, LevelOverride, LevelOverrides, LevelRole } from '../config/levels.config';
import { markSettingsChanged } from './settings-revision';

/**
 * The owner-editable identity of the three level ladders: the NAME and the COLOUR (dark / light) of each level. Stored as ONE row of `platform_settings` (key `levelIdentity`, versioned,
 * so two admins cannot overwrite each other); every instance re-reads it when the settings bus announces the key (and at boot). The workbook names and the brand colour formula stay the
 * default. Percentages, thresholds and who is on which level are not touched by anything here.
 */
export const LEVEL_IDENTITY_KEY = 'levelIdentity';
export const LEVEL_IDENTITY_CONFLICT = 'LEVEL_IDENTITY_VERSION_CONFLICT';
export const NAME_MAX = 24;
const ROLES: readonly LevelRole[] = ['PROVIDER', 'CLIENT', 'MARKETER'];
const HEX = /^#[0-9a-fA-F]{6}$/;
const NAME_OK = /^[\p{L}\p{N}][\p{L}\p{M}\p{N} _\-.]*$/u; // letters (with Arabic marks such as tanween), digits, space, _ - .

export interface LevelIdentityChange { role: string; level: number; name?: string | null; dark?: string | null; light?: string | null }
export interface LevelIdentityRow { role: LevelRole; level: number; name: string; defaultName: string; color: { dark: string; light: string }; defaultColor: { dark: string; light: string }; overridden: { name: boolean; dark: boolean; light: boolean } }
export interface AuditCtx { ip?: string; device?: string }

const bad = (field: string, message: string) => fieldError(field, message);

/** the stored JSON -> overrides, dropping anything that is not a valid value (a hand-edited row can never put junk on the site) */
export function parseOverrides(raw: unknown): LevelOverrides {
	const out: LevelOverrides = {};
	if (!raw || typeof raw !== 'object') return out;
	for (const role of ROLES) {
		const byLevel = (raw as Record<string, unknown>)[role];
		if (!byLevel || typeof byLevel !== 'object') continue;
		for (const [lvl, v] of Object.entries(byLevel as Record<string, unknown>)) {
			const n = Number(lvl); if (!Number.isInteger(n) || n < 1 || n > LEVELS_BY_ROLE[role].length || !v || typeof v !== 'object') continue;
			const o: LevelOverride = {}; const r = v as Record<string, unknown>;
			if (typeof r.name === 'string' && r.name.trim() && r.name.trim().length <= NAME_MAX && NAME_OK.test(r.name.trim())) o.name = r.name.trim();
			if (typeof r.dark === 'string' && HEX.test(r.dark)) o.dark = r.dark.toUpperCase();
			if (typeof r.light === 'string' && HEX.test(r.light)) o.light = r.light.toUpperCase();
			if (o.name || o.dark || o.light) (out[role] ??= {})[String(n)] = o;
		}
	}
	return out;
}

/** apply the requested changes to the current overrides; throws a field error for the first invalid value. `null` = back to the default of that field. */
export function applyChanges(current: LevelOverrides, changes: unknown): LevelOverrides {
	if (!Array.isArray(changes) || !changes.length) throw bad('changes', 'لا يوجد تغيير لحفظه.');
	if (changes.length > 45) throw bad('changes', 'عدد التغييرات أكبر من المسموح.');
	const next: LevelOverrides = JSON.parse(JSON.stringify(current));
	for (const [i, c] of (changes as LevelIdentityChange[]).entries()) {
		const f = `changes[${i}]`;
		if (!c || typeof c !== 'object') throw bad(f, 'تغيير غير صالح.');
		if (!ROLES.includes(c.role as LevelRole)) throw bad(`${f}.role`, 'نوع الحساب غير معروف.');
		const role = c.role as LevelRole;
		if (!Number.isInteger(c.level) || c.level < 1 || c.level > LEVELS_BY_ROLE[role].length) throw bad(`${f}.level`, 'المستوى خارج النطاق (1 إلى 15).');
		const o: LevelOverride = { ...(next[role]?.[String(c.level)] ?? {}) };
		if (c.name !== undefined) {
			if (c.name === null || (typeof c.name === 'string' && !c.name.trim())) delete o.name;
			else {
				if (typeof c.name !== 'string') throw bad(`${f}.name`, 'الاسم يجب أن يكون نصًا.');
				const name = c.name.trim().replace(/\s+/g, ' ');
				if (name.length > NAME_MAX) throw bad(`${f}.name`, `الاسم أطول من ${NAME_MAX} حرفًا.`);
				if (!NAME_OK.test(name)) throw bad(`${f}.name`, 'الاسم يقبل حروفًا وأرقامًا ومسافات وشرطات فقط.');
				o.name = name;
			}
		}
		for (const theme of ['dark', 'light'] as const) {
			const v = c[theme]; if (v === undefined) continue;
			if (v === null || v === '') delete o[theme];
			else { if (typeof v !== 'string' || !HEX.test(v)) throw bad(`${f}.${theme}`, 'اللون يجب أن يكون بصيغة #rrggbb.'); o[theme] = v.toUpperCase(); }
		}
		const levels = (next[role] ??= {});
		if (o.name || o.dark || o.light) levels[String(c.level)] = o; else delete levels[String(c.level)];
		if (!Object.keys(levels).length) delete next[role];
	}
	// no two levels of the same ladder may end up with the same name (the badge text is how people tell them apart)
	for (const role of ROLES) {
		const seen = new Map<string, number>();
		for (let l = 1; l <= LEVELS_BY_ROLE[role].length; l++) {
			const name = (next[role]?.[String(l)]?.name ?? defaultLevelName(role, l)).trim();
			const prev = seen.get(name); if (prev !== undefined) throw bad(`${role}.${l}.name`, `الاسم «${name}» مستعمل في المستوى ${prev} من القائمة نفسها.`);
			seen.set(name, l);
		}
	}
	return next;
}

export class LevelIdentityService {
	version = 0;
	constructor(private readonly db: typeof defaultPrisma = defaultPrisma) {}

	/** load the stored overrides into this process (boot, a settings notice, after a save). A failure keeps the last good state and is logged. */
	async refresh(): Promise<void> {
		try {
			const row = await this.db.platformSetting.findUnique({ where: { key: LEVEL_IDENTITY_KEY } });
			applyLevelOverrides(parseOverrides(row?.value)); this.version = row?.version ?? 0;
		} catch (e) { logger.warn(`[LevelIdentity] refresh failed, keeping the last state: ${(e as Error)?.message}`); }
	}

	rows(): LevelIdentityRow[] {
		return ROLES.flatMap(role => LEVELS_BY_ROLE[role].map(def => {
			const o = levelOverrideOf(role, def.level);
			const dc = { dark: defaultLevelColor(role, def.level, 'dark'), light: defaultLevelColor(role, def.level, 'light') };
			return { role, level: def.level, name: def.name, defaultName: defaultLevelName(role, def.level), color: { dark: o.dark ?? dc.dark, light: o.light ?? dc.light }, defaultColor: dc, overridden: { name: !!o.name, dark: !!o.dark, light: !!o.light } };
		}));
	}

	async view(): Promise<{ version: number; nameMax: number; rows: LevelIdentityRow[] }> { await this.refresh(); return { version: this.version, nameMax: NAME_MAX, rows: this.rows() }; }

	async save(userId: string, ctx: AuditCtx, expectedVersion: unknown, changes: unknown) {
		if (!Number.isInteger(expectedVersion) || (expectedVersion as number) < 0) throw bad('expectedVersion', 'نسخة الحالة المقروءة مطلوبة.');
		let before: LevelOverrides = {}; let after: LevelOverrides = {};
		try {
			await this.db.$transaction(async tx => {
				await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('level-identity'))`;
				const row = await tx.platformSetting.findUnique({ where: { key: LEVEL_IDENTITY_KEY } });
				if ((row?.version ?? 0) !== expectedVersion) throw new AppError('عُدّلت هوية المستويات من جهة أخرى بعد أن فتحت الصفحة. أعد التحميل وراجع الحالة الحالية.', 409, undefined, LEVEL_IDENTITY_CONFLICT);
				before = parseOverrides(row?.value);
				after = applyChanges(before, changes);
				if (JSON.stringify(after) === JSON.stringify(before)) throw bad('changes', 'لا فرق عن القيم المنشورة.');
				const value = after as unknown as Prisma.InputJsonValue;
				if (row) await tx.platformSetting.update({ where: { key: LEVEL_IDENTITY_KEY }, data: { value, version: { increment: 1 }, updatedBy: userId } });
				else await tx.platformSetting.create({ data: { key: LEVEL_IDENTITY_KEY, value, version: 1, updatedBy: userId } });
				await markSettingsChanged(tx, [LEVEL_IDENTITY_KEY]);
				await tx.accountAuditLog.create({ data: {
					userId, category: LogCategory.SYSTEM_AUDIT, title: 'تعديل هوية المستويات', actionText: 'تعديل اسم أو لون مستوى', summary: `تعديل هوية المستويات (${(changes as unknown[]).length} تغيير)`,
					eventType: 'LEVEL_IDENTITY_UPDATED', source: 'ADMIN', severity: 'INFO', status: LogStatus.COMPLETED, actorLabel: 'ADMIN',
					beforeData: before as unknown as Prisma.InputJsonValue, afterData: after as unknown as Prisma.InputJsonValue, metaData: { key: LEVEL_IDENTITY_KEY } as Prisma.InputJsonValue, ipAddress: ctx.ip?.slice(0, 80), device: ctx.device?.slice(0, 120),
				} });
			}, { timeout: 15_000 });
		} catch (e) {
			if (e instanceof AppError && e.code === LEVEL_IDENTITY_CONFLICT) { await this.refresh(); (e as AppError & { current?: unknown }).current = { version: this.version, rows: this.rows() }; }
			throw e;
		}
		await this.refresh(); // this process follows at once; the other instances follow through the bus notice written in the same transaction
		return { version: this.version, nameMax: NAME_MAX, rows: this.rows() };
	}
}
export const levelIdentityService = new LevelIdentityService();
