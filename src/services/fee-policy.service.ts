import { LogCategory, LogStatus, Prisma } from '@prisma/client';
import { prisma as defaultPrisma } from '../config/db';
import { logger } from '../config/logger';
import { AppError, fieldErrors } from '../utils/app-error';
import { isMissingTableError } from '../utils/missing-table';
import { BASELINE_FEE_POLICY_ID, FEE_LIMITS, FeePolicyPayload, baselineFeePolicyPayload, diffFeePolicy, feePolicyPayloadSchema } from '../config/fee-policy.schema';

export const FEE_POLICY_CONFLICT = 'FEE_POLICY_VERSION_CONFLICT';
export const FEE_POLICY_CONFIRMATION_REQUIRED = 'FEE_POLICY_CONFIRMATION_REQUIRED';
export const FEE_POLICY_MIN_LEAD_MINUTES = 15;
export const FEE_POLICY_MAX_LEAD_DAYS = 366;
export const FEE_POLICY_CACHE_MS = 5000;
/** Fields that are shown but have NO financial effect today (no cashback credit exists; no code deducts the marketer withdrawal fee): they cannot be changed until their path is built and tested, so a saved number never promises something that is not applied. */
export const FEE_POLICY_DISPLAY_ONLY = ['clientCashbackByLevel', 'marketerWithdrawalFeePercent'] as const;
const ADVISORY_LOCK = 7_260_001;

export interface PolicyRow { id: string; version: number; effectiveFrom: Date; payload: FeePolicyPayload; note: string | null; createdById: string | null; createdAt: Date; cancelledAt: Date | null }
const BASELINE_ROW = (): PolicyRow => ({ id: BASELINE_FEE_POLICY_ID, version: 1, effectiveFrom: new Date('2000-01-01T00:00:00Z'), payload: baselineFeePolicyPayload(), note: 'baseline (built-in fallback)', createdById: null, createdAt: new Date('2000-01-01T00:00:00Z'), cancelledAt: null });
const toRow = (r: { id: string; version: number; effectiveFrom: Date; payload: unknown; note: string | null; createdById: string | null; createdAt: Date; cancelledAt: Date | null }): PolicyRow | null => {
	const p = feePolicyPayloadSchema.safeParse(r.payload);
	if (!p.success) { logger.error(`[FeePolicy] version ${r.version} has an invalid payload and is ignored: ${p.error.issues[0]?.message}`); return null; }
	return { id: r.id, version: r.version, effectiveFrom: r.effectiveFrom, payload: p.data, note: r.note, createdById: r.createdById, createdAt: r.createdAt, cancelledAt: r.cancelledAt };
};

/**
 * Versioned financial terms. A version is immutable; "the policy in force at T" is the latest non-cancelled version whose effectiveFrom <= T. Every money operation stores the id it was created
 * under, so a later version never changes an existing contract, deposit or withdrawal. Reads never throw: unreadable store = last known good rows, else the baseline built from today's constants.
 */
export class FeePolicyService {
	private cache: { at: number; rows: PolicyRow[] } | null = null;
	private lastGood: PolicyRow[] | null = null;
	constructor(private db: typeof defaultPrisma = defaultPrisma) {}
	invalidate() { this.cache = null; }

	private async rows(force = false): Promise<PolicyRow[]> {
		if (!force && this.cache && Date.now() - this.cache.at < FEE_POLICY_CACHE_MS) return this.cache.rows;
		try {
			const raw = await this.db.feePolicyVersion.findMany({ orderBy: { version: 'asc' } });
			const rows = raw.map(toRow).filter((r): r is PolicyRow => !!r);
			const out = rows.length ? rows : [BASELINE_ROW()];
			this.cache = { at: Date.now(), rows: out }; this.lastGood = out; return out;
		} catch (e) {
			if (isMissingTableError(e)) { const out = [BASELINE_ROW()]; this.cache = { at: Date.now(), rows: out }; return out; }
			logger.error(`[FeePolicy] read failed, using ${this.lastGood ? 'the last known good versions' : 'the baseline'}: ${(e as Error)?.message ?? e}`);
			return this.lastGood ?? [BASELINE_ROW()];
		}
	}

	/** the policy in force at `at` (default now). Never throws. */
	async active(at: Date = new Date()): Promise<PolicyRow> {
		const rows = (await this.rows()).filter(r => !r.cancelledAt && r.effectiveFrom.getTime() <= at.getTime());
		rows.sort((a, b) => b.effectiveFrom.getTime() - a.effectiveFrom.getTime() || b.version - a.version);
		return rows[0] ?? BASELINE_ROW();
	}
	/** the version an operation was created under (NULL = created before policies were stored = the baseline, version 1). Never throws. */
	async byId(id: string | null | undefined): Promise<PolicyRow> {
		const rows = await this.rows();
		return (id ? rows.find(r => r.id === id) : rows.find(r => r.version === 1)) ?? rows.find(r => r.version === 1) ?? BASELINE_ROW();
	}
	async upcoming(now: Date = new Date()): Promise<PolicyRow[]> { return (await this.rows(true)).filter(r => !r.cancelledAt && r.effectiveFrom.getTime() > now.getTime()); }

	async view(now: Date = new Date()) {
		const rows = await this.rows(true); const active = await this.active(now);
		return {
			active: this.out(active), activeSource: active.note === BASELINE_ROW().note && active.createdById === null && active.id === BASELINE_FEE_POLICY_ID ? 'built-in fallback' as const : 'stored' as const, upcoming: rows.filter(r => !r.cancelledAt && r.effectiveFrom > now).map(r => this.out(r)),
			history: [...rows].sort((a, b) => b.version - a.version).slice(0, 30).map(r => this.out(r, now)),
			limits: { ...FEE_LIMITS, minLeadMinutes: FEE_POLICY_MIN_LEAD_MINUTES, maxLeadDays: FEE_POLICY_MAX_LEAD_DAYS }, now: now.toISOString(),
		};
	}
	private out(r: PolicyRow, now?: Date) { return { id: r.id, version: r.version, effectiveFrom: r.effectiveFrom, payload: r.payload, note: r.note, createdById: r.createdById, createdAt: r.createdAt, cancelledAt: r.cancelledAt, state: r.cancelledAt ? 'CANCELLED' : r.effectiveFrom > (now ?? new Date()) ? 'SCHEDULED' : 'EFFECTIVE' }; }

	/** Schedules a NEW version. `changes` is applied over the latest non-cancelled version (arrays / tables are replaced whole); `baseVersion` must be the latest version the caller saw (no silent overwrite). */
	async schedule(actorId: string, input: unknown, ctx: { ip?: string; device?: string } = {}) {
		const b = input && typeof input === 'object' && !Array.isArray(input) ? input as Record<string, unknown> : null;
		if (!b || Object.keys(b).some(k => !['changes', 'effectiveFrom', 'note', 'baseVersion', 'confirmSensitive'].includes(k))) throw new AppError('صيغة الطلب غير صحيحة', 400);
		const errors: Array<{ field: string; message: string }> = [];
		const from = typeof b.effectiveFrom === 'string' ? new Date(b.effectiveFrom) : null; const now = new Date();
		if (!from || Number.isNaN(from.getTime())) errors.push({ field: 'effectiveFrom', message: 'تاريخ السريان مطلوب' });
		else if (from.getTime() < now.getTime() + FEE_POLICY_MIN_LEAD_MINUTES * 60_000) errors.push({ field: 'effectiveFrom', message: `يجب أن يكون السريان بعد ${FEE_POLICY_MIN_LEAD_MINUTES} دقيقة على الأقل من الآن` });
		else if (from.getTime() > now.getTime() + FEE_POLICY_MAX_LEAD_DAYS * 86_400_000) errors.push({ field: 'effectiveFrom', message: 'تاريخ السريان بعيد جدًا' });
		const note = typeof b.note === 'string' ? b.note.trim().slice(0, 300) : '';
		if (!note) errors.push({ field: 'note', message: 'سبب التعديل مطلوب' });
		if (!b.changes || typeof b.changes !== 'object' || Array.isArray(b.changes) || !Object.keys(b.changes as object).length) errors.push({ field: 'changes', message: 'لا توجد تغييرات' });
		if (!Number.isInteger(b.baseVersion)) errors.push({ field: 'baseVersion', message: 'رقم آخر نسخة مطلوب لمنع استبدال تعديل أحدث' });
		if (errors.length) throw fieldErrors(errors[0].message, errors);
		const blocked = Object.keys(b.changes as object).filter(k => (FEE_POLICY_DISPLAY_ONLY as readonly string[]).includes(k));
		if (blocked.length) throw fieldErrors('هذه القيم للعرض فقط ولا تُطبَّق ماليًا حاليًا، فلا يمكن تعديلها.', blocked.map(f => ({ field: f, message: 'للعرض فقط: لا يوجد مسار مالي يطبّقها بعد' })));
		const all = (await this.rows(true)).filter(r => !r.cancelledAt); const latest = all.reduce((m, r) => (r.version > m.version ? r : m), all[0]);
		if (latest.version !== b.baseVersion) throw new AppError('تغيّرت سياسة الرسوم من جهة أخرى. أعد التحميل وراجع التغيير.', 409, [{ current: this.out(latest) }], FEE_POLICY_CONFLICT);
		if ((await this.upcoming(now)).length) throw new AppError('توجد نسخة مجدولة لم تسرِ بعد: ألغِها أو انتظر سريانها قبل جدولة نسخة جديدة.', 409, undefined, FEE_POLICY_CONFLICT);
		const next = feePolicyPayloadSchema.safeParse({ ...latest.payload, ...(b.changes as object) });
		if (!next.success) throw fieldErrors(next.error.issues[0]?.message || 'قيمة غير صالحة', next.error.issues.map(i => ({ field: i.path.join('.') || 'changes', message: i.message })));
		const diff = diffFeePolicy(latest.payload, next.data); if (!diff.length) throw new AppError('لا يوجد فرق عن السياسة الحالية', 400);
		if (b.confirmSensitive !== true) throw new AppError('تغيير الرسوم والعمولات يحتاج تأكيدًا صريحًا', 409, [{ diff, effectiveFrom: from }], FEE_POLICY_CONFIRMATION_REQUIRED);
		let row;
		try {
			row = await this.db.$transaction(async tx => {
				// one writer at a time: the "latest version" and "nothing pending" checks below must hold when the row is inserted, not when the request arrived
				await tx.$executeRaw`SELECT pg_advisory_xact_lock(${ADVISORY_LOCK})`;
				const fresh = await tx.feePolicyVersion.findMany({ where: { cancelledAt: null }, select: { version: true, effectiveFrom: true } });
				if (Math.max(1, ...fresh.map(r => r.version)) !== latest.version) throw new AppError('تغيّرت سياسة الرسوم من جهة أخرى. أعد التحميل وراجع التغيير.', 409, undefined, FEE_POLICY_CONFLICT);
				if (fresh.some(r => r.effectiveFrom.getTime() > Date.now())) throw new AppError('توجد نسخة مجدولة لم تسرِ بعد: ألغِها أو انتظر سريانها قبل جدولة نسخة جديدة.', 409, undefined, FEE_POLICY_CONFLICT);
				// a database created without the migration seed (db push in tests / a fresh environment) has no version 1 yet: store the baseline so that "the base" of every change is a real row
				if (!(await tx.feePolicyVersion.findFirst({ where: { version: 1 }, select: { id: true } }))) await tx.feePolicyVersion.create({ data: { id: BASELINE_FEE_POLICY_ID, version: 1, effectiveFrom: new Date('2000-01-01T00:00:00Z'), payload: baselineFeePolicyPayload() as Prisma.InputJsonValue, note: 'baseline: the values in force before fee policies were managed (unchanged)' } });
				const max = await tx.feePolicyVersion.aggregate({ _max: { version: true } });
				const created = await tx.feePolicyVersion.create({ data: { version: (max._max.version ?? 0) + 1, effectiveFrom: from!, payload: next.data as Prisma.InputJsonValue, note, createdById: actorId } });
				await tx.accountAuditLog.create({ data: { userId: actorId, category: LogCategory.SYSTEM_AUDIT, title: 'جدولة تعديل سياسة الرسوم', actionText: `نسخة ${created.version} تسري من ${from!.toISOString()}`, summary: `نسخة ${created.version} تسري من ${from!.toISOString()}: ${diff.length} تغيير`, eventType: 'FEE_POLICY_SCHEDULED', source: 'ADMIN', severity: 'WARNING', status: LogStatus.COMPLETED, actorLabel: 'ADMIN',
					beforeData: Object.fromEntries(diff.map(d => [d.path, d.from])) as Prisma.InputJsonValue, afterData: Object.fromEntries(diff.map(d => [d.path, d.to])) as Prisma.InputJsonValue, metaData: { version: created.version, baseVersion: latest.version, effectiveFrom: from!.toISOString(), note } as Prisma.InputJsonValue, ipAddress: ctx.ip?.slice(0, 80), device: ctx.device?.slice(0, 120) } });
				return created;
			});
		} catch (e) { if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') throw new AppError('تغيّرت سياسة الرسوم من جهة أخرى. أعد التحميل وراجع التغيير.', 409, undefined, FEE_POLICY_CONFLICT); throw e; }
		this.invalidate();
		return { version: row.version, id: row.id, effectiveFrom: row.effectiveFrom, diff };
	}

	/** A scheduled version can be withdrawn only BEFORE it takes effect; an effective one is history and can only be followed by a newer version. */
	async cancel(actorId: string, id: string, ctx: { ip?: string; device?: string } = {}) {
		const row = await this.db.feePolicyVersion.findUnique({ where: { id } });
		if (!row) throw new AppError('النسخة غير موجودة', 404);
		if (row.version === 1) throw new AppError('النسخة الأساسية لا تُلغى', 409);
		if (row.cancelledAt) throw new AppError('أُلغيت هذه النسخة سابقًا', 409);
		if (row.effectiveFrom <= new Date()) throw new AppError('سرت هذه النسخة بالفعل ولا يمكن إلغاؤها؛ جدول نسخة جديدة بدلًا منها.', 409);
		await this.db.$transaction(async tx => {
			const r = await tx.feePolicyVersion.updateMany({ where: { id, cancelledAt: null, effectiveFrom: { gt: new Date() } }, data: { cancelledAt: new Date(), cancelledById: actorId } });
			if (r.count === 0) throw new AppError('تعذّر الإلغاء: تغيّرت حالة النسخة.', 409, undefined, FEE_POLICY_CONFLICT);
			await tx.accountAuditLog.create({ data: { userId: actorId, category: LogCategory.SYSTEM_AUDIT, title: 'إلغاء نسخة مجدولة من سياسة الرسوم', actionText: `إلغاء النسخة ${row.version}`, summary: `إلغاء النسخة المجدولة ${row.version}`, eventType: 'FEE_POLICY_CANCELLED', source: 'ADMIN', severity: 'WARNING', status: LogStatus.COMPLETED, actorLabel: 'ADMIN', metaData: { version: row.version } as Prisma.InputJsonValue, ipAddress: ctx.ip?.slice(0, 80), device: ctx.device?.slice(0, 120) } });
		});
		this.invalidate(); return { version: row.version, cancelled: true };
	}
}
export const feePolicyService = new FeePolicyService();
