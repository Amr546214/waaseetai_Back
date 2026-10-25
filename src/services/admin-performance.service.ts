import { prisma as defaultPrisma } from '../config/db';
import { fieldError } from '../utils/app-error';

/**
 * Team performance computed ONLY from recorded task events. Definitions (shown to the user, never hidden):
 *  - completed task: a task whose status became DONE inside the period (completedAt);
 *  - completion time: completedAt minus createdAt, in hours;
 *  - on-time: among completed tasks that HAVE a due date, those completed on or before it;
 *  - NOT available because nothing records them yet, and no rule has been decided: SLA target, users' rating of staff, overall score. They are returned as null, never as 0 or as a design sample value.
 */
export type Period = 'month' | 'quarter' | 'year';
const periodRange = (p: Period, now: Date) => {
	const y = now.getUTCFullYear(), m = now.getUTCMonth();
	if (p === 'year') return { from: new Date(Date.UTC(y, 0, 1)), to: new Date(Date.UTC(y + 1, 0, 1)) };
	if (p === 'quarter') { const q = Math.floor(m / 3) * 3; return { from: new Date(Date.UTC(y, q, 1)), to: new Date(Date.UTC(y, q + 3, 1)) }; }
	return { from: new Date(Date.UTC(y, m, 1)), to: new Date(Date.UTC(y, m + 1, 1)) };
};
const r1 = (n: number) => Math.round(n * 10) / 10;

export const PERFORMANCE_DEFINITIONS = {
	completed: 'مهمة انتقلت إلى «مكتملة» خلال الفترة',
	completionTime: 'من إنشاء المهمة حتى اكتمالها، بالساعات',
	onTime: 'من المهام المكتملة التي لها موعد، نسبة ما اكتمل في موعده أو قبله',
	unavailable: ['هدف SLA', 'تقييم المستخدمين للموظف', 'الدرجة الكلية'],
	decisionsNeeded: ['هدف SLA بالساعات لكل نوع مهمة', 'مصدر تقييم المستخدمين للموظفين (غير موجود الآن)', 'قاعدة وأوزان الدرجة الكلية'],
};

export class AdminPerformanceService {
	constructor(private db: typeof defaultPrisma = defaultPrisma, private now: () => Date = () => new Date()) {}

	async report(periodRaw: unknown) {
		const period = (periodRaw ?? 'month') as Period;
		if (!['month', 'quarter', 'year'].includes(period)) throw fieldError('period', 'الفترة غير صالحة');
		const now = this.now(), { from, to } = periodRange(period, now);
		const [done, staff, openNow] = await Promise.all([
			this.db.adminTask.findMany({ where: { status: 'DONE', completedAt: { gte: from, lt: to }, assigneeId: { not: null } }, select: { assigneeId: true, createdAt: true, completedAt: true, dueAt: true } }),
			this.db.adminStaff.findMany({ include: { user: { select: { firstName: true, lastName: true } }, role: { select: { name: true, color: true } } }, orderBy: { joinedAt: 'asc' } }),
			this.db.adminTask.groupBy({ by: ['assigneeId'], where: { status: { in: ['NEW', 'IN_PROGRESS', 'PENDING'] }, assigneeId: { not: null } }, _count: { _all: true } }),
		]);
		const stat = (rows: typeof done) => {
			const withDue = rows.filter(t => t.dueAt);
			const onTime = withDue.filter(t => t.completedAt! <= t.dueAt!).length;
			return {
				completed: rows.length,
				avgCompletionHours: rows.length ? r1(rows.reduce((a, t) => a + (t.completedAt!.getTime() - t.createdAt.getTime()), 0) / rows.length / 3600_000) : null,
				onTimeRate: withDue.length ? Math.round((onTime / withDue.length) * 100) : null, onTimeOf: withDue.length,
			};
		};
		const open = new Map(openNow.map(o => [o.assigneeId, o._count._all]));
		const members = staff.map(s => ({ userId: s.userId, name: `${s.user.firstName} ${s.user.lastName}`.trim(), role: s.role?.name ?? null, roleColor: s.role?.color ?? null, status: s.status, openTasks: open.get(s.userId) ?? 0, ...stat(done.filter(t => t.assigneeId === s.userId)),
			slaRate: null as number | null, userRating: null as number | null, overallScore: null as number | null }));
		// monthly completions, this year vs last year (counts only)
		const yStart = new Date(Date.UTC(now.getUTCFullYear() - 1, 0, 1));
		const year = await this.db.adminTask.findMany({ where: { status: 'DONE', completedAt: { gte: yStart } }, select: { completedAt: true } });
		const trend = Array.from({ length: 12 }, (_, i) => ({ month: i + 1, thisYear: 0, lastYear: 0 }));
		for (const t of year) { const d = t.completedAt!; const row = trend[d.getUTCMonth()]; if (d.getUTCFullYear() === now.getUTCFullYear()) row.thisYear++; else row.lastYear++; }
		return { period, from, to, team: { members: staff.length, ...stat(done), slaRate: null, userRating: null, overallScore: null }, members, trend, definitions: PERFORMANCE_DEFINITIONS };
	}

	/** The export is the SAME data as the screen (same function, same scope): CSV built from `report()`. */
	async exportCsv(periodRaw: unknown) {
		const r = await this.report(periodRaw);
		const esc = (v: unknown) => { const s = v === null || v === undefined ? '' : String(v); return /^[=+\-@\t\r]/.test(s) ? `'${s}` : s; };
		const q = (v: unknown) => `"${esc(v).replace(/"/g, '""')}"`;
		const rows = [['الموظف', 'الدور', 'مهام مكتملة', 'متوسط وقت الإنجاز (ساعة)', 'الالتزام بالموعد %', 'مهام مفتوحة'].map(q).join(',')];
		for (const m of r.members) rows.push([m.name, m.role, m.completed, m.avgCompletionHours, m.onTimeRate, m.openTasks].map(q).join(','));
		return '﻿' + rows.join('\r\n') + '\r\n';
	}
}
export const adminPerformanceService = new AdminPerformanceService();
