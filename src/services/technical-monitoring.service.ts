import { prisma } from '../config/db';
import { assigneeHolds } from './admin-access.service';
import { DISPUTE_PERMISSIONS, SUPPORT_PERMISSIONS } from './case-sla.service';
import { LATENCY_EDGES, WINDOW_MINUTES, eventLoopDelay, requestMetrics } from './request-metrics';
import { cloudinaryUsageConfigured, fetchCloudinaryUsage } from '../utils/cloudinary-storage';

/**
 * Technical monitoring: every indicator is a real reading taken now, or it is `unavailable` with the reason. Never a guess, never 0 for "unknown".
 * Read-only: the database part only reads statistics views (bounded by a statement timeout); the provider part is one read-only usage call.
 */
export type Indicator = {
	key: string; group: 'api' | 'database' | 'backup' | 'cdn'; label: string; value: number | null; unit: string;
	status: 'measured' | 'unavailable' | 'error'; readAt: string; source: string; reason?: string;
};
const CACHE_MS = 15_000, CDN_CACHE_MS = 5 * 60_000, QUERY_TIMEOUT_MS = 3_000, PROVIDER_TIMEOUT_MS = 6_000;

const withTimeout = <T,>(p: Promise<T>, ms: number): Promise<T> => new Promise((res, rej) => {
	const t = setTimeout(() => rej(new Error('timeout')), ms); t.unref?.();
	p.then(v => { clearTimeout(t); res(v); }, e => { clearTimeout(t); rej(e); });
});
const round = (n: number, d = 1) => Math.round(n * 10 ** d) / 10 ** d;

export type MonitoringDeps = {
	/** run one read-only statement with a server-side timeout; rows come back as plain numbers/strings */
	query: (sql: string) => Promise<Record<string, any>[]>;
	cdnUsage: () => Promise<Awaited<ReturnType<typeof fetchCloudinaryUsage>>>;
	cdnConfigured: () => boolean;
	now: () => Date;
};
const defaultDeps: MonitoringDeps = {
	query: async sql => {
		const [, rows] = await prisma.$transaction([prisma.$executeRawUnsafe(`SET LOCAL statement_timeout = ${QUERY_TIMEOUT_MS}`), prisma.$queryRawUnsafe(sql)]);
		return rows as Record<string, any>[];
	},
	cdnUsage: fetchCloudinaryUsage, cdnConfigured: cloudinaryUsageConfigured, now: () => new Date(),
};

export class TechnicalMonitoringService {
	deps: MonitoringDeps = defaultDeps;
	private cache: { at: number; data: any } | null = null;
	private cdnCache: { at: number; items: Indicator[] } | null = null;
	private inflight: Promise<any> | null = null;
	reset() { this.cache = null; this.cdnCache = null; this.inflight = null; }

	async read() {
		const t = this.deps.now().getTime();
		if (this.cache && t - this.cache.at < CACHE_MS) return this.cache.data;
		if (this.inflight) return this.inflight;
		this.inflight = (async () => {
			try {
				const [database, cdn] = await Promise.all([this.database(), this.cdn()]);
				const data = { generatedAt: this.deps.now().toISOString(), cacheSeconds: CACHE_MS / 1000, windowMinutes: WINDOW_MINUTES, indicators: [...this.api(), ...database, ...this.backup(), ...cdn] };
				this.cache = { at: this.deps.now().getTime(), data };
				return data;
			} finally { this.inflight = null; }
		})();
		return this.inflight;
	}

	private ind(key: string, group: Indicator['group'], label: string, unit: string, value: number | null, source: string, reason?: string, status?: Indicator['status']): Indicator {
		const st = status ?? (value === null ? 'unavailable' : 'measured');
		return { key, group, label, value, unit, status: st, readAt: this.deps.now().toISOString(), source, ...(reason ? { reason } : {}) };
	}

	private api(): Indicator[] {
		const A = 'api' as const, s = requestMetrics.snapshot();
		const proc = 'قياس داخلي لهذه العملية (process)';
		const win = `عدّاد داخلي لهذه العملية، آخر ${s.coveredMinutes} دقيقة`;
		const mem = process.memoryUsage();
		const loop = eventLoopDelay(this.deps.now().getTime());
		const noReq = 'لا طلبات ضمن النافذة لحساب هذا المؤشر';
		const pct = (k: string, label: string, v: ReturnType<typeof requestMetrics.snapshot>['p50']) => this.ind(k, A, label, 'ms', v ? v.ms : null,
			`${win}؛ حد أعلى لفئة التوزيع (فئات: ${LATENCY_EDGES.join('/')} ms)`, v ? (v.capped ? `القيمة تتجاوز ${v.ms} ms (سقف الفئات)` : undefined) : noReq);
		return [
			this.ind('api_uptime', A, 'مدة تشغيل العملية', 'ثانية', Math.floor(process.uptime()), proc),
			this.ind('api_rss', A, 'ذاكرة العملية (RSS)', 'MB', round(mem.rss / 1048576), proc),
			this.ind('api_heap', A, 'ذاكرة الكومة المستخدمة', 'MB', round(mem.heapUsed / 1048576), proc),
			this.ind('api_loop_p99', A, 'تأخر حلقة الأحداث (p99)', 'ms', loop ? loop.p99Ms : null, 'perf_hooks.monitorEventLoopDelay، منذ آخر إعادة ضبط (حتى ٥ دقائق)', loop ? undefined : 'لم تتوفر عينات بعد'),
			this.ind('api_requests', A, 'عدد الطلبات', 'طلب', s.total, win),
			this.ind('api_2xx', A, 'طلبات ناجحة (2xx)', 'طلب', s.s2, win),
			this.ind('api_4xx', A, 'أخطاء العميل (4xx)', 'طلب', s.s4, win),
			this.ind('api_5xx', A, 'أخطاء الخادم (5xx)', 'طلب', s.s5, win),
			this.ind('api_429', A, 'طلبات مرفوضة بحد المعدل (429)', 'طلب', s.s429, win),
			this.ind('api_5xx_rate', A, 'نسبة أخطاء الخادم', '%', s.total ? round((s.s5 / s.total) * 100, 2) : null, win, s.total ? undefined : noReq),
			pct('api_p50', 'زمن الاستجابة (p50)', s.p50), pct('api_p95', 'زمن الاستجابة (p95)', s.p95), pct('api_p99', 'زمن الاستجابة (p99)', s.p99),
		];
	}

	private async database(): Promise<Indicator[]> {
		const D = 'database' as const, out: Indicator[] = [];
		const fail = (key: string, label: string, unit: string, source: string, e: unknown, reason?: string) =>
			this.ind(key, D, label, unit, null, source, reason ?? ((e as Error)?.message === 'timeout' ? 'انتهت مهلة القراءة' : 'تعذّرت القراءة من قاعدة البيانات'), 'error');
		const run = (sql: string) => withTimeout(this.deps.query(sql), QUERY_TIMEOUT_MS + 1000);
		const t0 = process.hrtime.bigint();
		try { await run('SELECT 1 AS ok'); out.push(this.ind('db_latency', D, 'زمن استجابة استعلام بسيط', 'ms', round(Number(process.hrtime.bigint() - t0) / 1e6, 1), 'قياس زمن SELECT 1 من التطبيق')); }
		catch (e) { out.push(fail('db_latency', 'زمن استجابة استعلام بسيط', 'ms', 'قياس زمن SELECT 1 من التطبيق', e)); }
		const stat = async () => {
			const r = await run(`SELECT numbackends::float8 AS backends, blks_hit::float8 AS hit, blks_read::float8 AS read, deadlocks::float8 AS deadlocks, temp_files::float8 AS temp_files,
				pg_database_size(datname)::float8 AS size, xact_commit::float8 AS commit, xact_rollback::float8 AS rollback, stats_reset FROM pg_stat_database WHERE datname = current_database()`);
			return r[0];
		};
		const S = 'pg_stat_database / pg_database_size';
		try {
			const r = await stat(); if (!r) throw new Error('none');
			const total = Number(r.hit) + Number(r.read);
			out.push(this.ind('db_size', D, 'حجم قاعدة البيانات', 'MB', round(Number(r.size) / 1048576), S));
			out.push(this.ind('db_cache_hit', D, 'نسبة إصابة الذاكرة المؤقتة', '%', total > 0 ? round((Number(r.hit) / total) * 100, 2) : null, `${S}، منذ ${r.stats_reset ? 'آخر إعادة ضبط للإحصاءات' : 'بدء جمع الإحصاءات'}`, total > 0 ? undefined : 'لا قراءات كتل مسجلة بعد'));
			out.push(this.ind('db_deadlocks', D, 'حالات التعطل المتبادل (deadlocks)', 'حالة', Number(r.deadlocks), `${S}، تراكمي منذ آخر إعادة ضبط للإحصاءات`));
			out.push(this.ind('db_temp_files', D, 'ملفات مؤقتة أُنشئت', 'ملف', Number(r.temp_files), `${S}، تراكمي منذ آخر إعادة ضبط للإحصاءات`));
			const xt = Number(r.commit) + Number(r.rollback);
			out.push(this.ind('db_rollback_rate', D, 'نسبة المعاملات المتراجَع عنها', '%', xt > 0 ? round((Number(r.rollback) / xt) * 100, 2) : null, `${S}، تراكمي`, xt > 0 ? undefined : 'لا معاملات مسجلة بعد'));
		} catch (e) { for (const [k, l, u] of [['db_size', 'حجم قاعدة البيانات', 'MB'], ['db_cache_hit', 'نسبة إصابة الذاكرة المؤقتة', '%'], ['db_deadlocks', 'حالات التعطل المتبادل (deadlocks)', 'حالة'], ['db_temp_files', 'ملفات مؤقتة أُنشئت', 'ملف'], ['db_rollback_rate', 'نسبة المعاملات المتراجَع عنها', '%']]) out.push(fail(k, l, u, S, e)); }
		const SA = 'pg_stat_activity / max_connections';
		try {
			const r = (await run(`SELECT count(*)::float8 AS total, (count(*) FILTER (WHERE state = 'active'))::float8 AS active, current_setting('max_connections')::float8 AS max FROM pg_stat_activity WHERE datname = current_database()`))[0];
			out.push(this.ind('db_connections', D, 'الاتصالات الحالية', 'اتصال', Number(r.total), SA));
			out.push(this.ind('db_active', D, 'استعلامات نشطة الآن', 'استعلام', Number(r.active), SA));
			out.push(this.ind('db_conn_usage', D, 'نسبة استخدام حد الاتصالات', '%', Number(r.max) > 0 ? round((Number(r.total) / Number(r.max)) * 100, 1) : null, SA));
		} catch (e) { for (const [k, l, u] of [['db_connections', 'الاتصالات الحالية', 'اتصال'], ['db_active', 'استعلامات نشطة الآن', 'استعلام'], ['db_conn_usage', 'نسبة استخدام حد الاتصالات', '%']]) out.push(fail(k, l, u, SA, e)); }
		const SS = 'pg_stat_statements', slowL = 'استعلامات بمتوسط أبطأ من ثانية', slowU = 'استعلام';
		try {
			const ext = await run(`SELECT 1 AS present FROM pg_extension WHERE extname = 'pg_stat_statements'`);
			if (!ext.length) out.push(this.ind('db_slow_queries', D, slowL, slowU, null, SS, 'الإضافة pg_stat_statements غير مثبّتة في قاعدة البيانات؛ المطلوب تفعيلها (shared_preload_libraries + CREATE EXTENSION) من فريق البنية'));
			else {
				try {
					const r = (await run(`SELECT (count(*) FILTER (WHERE mean_exec_time > 1000))::float8 AS slow FROM pg_stat_statements WHERE dbid = (SELECT oid FROM pg_database WHERE datname = current_database())`))[0];
					out.push(this.ind('db_slow_queries', D, slowL, slowU, Number(r.slow), `${SS}، تراكمي منذ آخر إعادة ضبط`));
				} catch { out.push(this.ind('db_slow_queries', D, slowL, slowU, null, SS, 'الإضافة مثبّتة لكن العرض غير قابل للقراءة (غير مُحمّلة في shared_preload_libraries أو بلا صلاحية قراءة)')); }
			}
		} catch (e) { out.push(fail('db_slow_queries', slowL, slowU, SS, e)); }
		return out;
	}

	/** the two indicators the deprecated /health items mirror: no database queries, the provider reading comes from the same 5-minute cache as technical-metrics */
	async cdnAndBackup(): Promise<Indicator[]> { return [...(await this.cdn()), ...this.backup()]; }

	private backup(): Indicator[] {
		const reason = 'مهمة النسخ الاحتياطي تعمل خارج التطبيق ولا تنشر وقت آخر نجاح؛ المطلوب ملف حالة أو نقطة قراءة من مهمة النسخ (وقت آخر نجاح، الحجم، نتيجة اختبار الاستعادة)';
		return [
			this.ind('backup_last_success', 'backup', 'وقت آخر نسخة احتياطية ناجحة', 'تاريخ', null, 'لا يوجد سجل نسخ يقرأه التطبيق', reason),
			this.ind('backup_size', 'backup', 'حجم آخر نسخة', 'MB', null, 'لا يوجد سجل نسخ يقرأه التطبيق', reason),
			this.ind('backup_restore_test', 'backup', 'نتيجة آخر اختبار استعادة', 'تاريخ', null, 'لا يوجد سجل نسخ يقرأه التطبيق', reason),
		];
	}

	private async cdn(): Promise<Indicator[]> {
		const C = 'cdn' as const, S = 'Cloudinary Admin API (usage)';
		const now = this.deps.now().getTime();
		if (this.cdnCache && now - this.cdnCache.at < CDN_CACHE_MS) return this.cdnCache.items;
		const labels: [string, string, string][] = [['cdn_storage', 'مساحة التخزين المستخدمة', 'MB'], ['cdn_bandwidth', 'عرض النطاق المستخدم (الدورة الحالية)', 'MB'], ['cdn_transformations', 'التحويلات المستخدمة (الدورة الحالية)', 'تحويل'], ['cdn_resources', 'عدد الملفات المخزنة', 'ملف']];
		const items: Indicator[] = [];
		if (!this.deps.cdnConfigured()) {
			for (const [k, l, u] of labels) items.push(this.ind(k, C, l, u, null, S, 'تكامل Cloudinary غير مهيأ في هذه البيئة (متغيرات الإعداد غير موجودة أو وضع التطوير المحلي)'));
		} else {
			try {
				const u = await withTimeout(this.deps.cdnUsage(), PROVIDER_TIMEOUT_MS);
				const mb = (b: number | null) => (b === null ? null : round(b / 1048576));
				const vals = [mb(u.storageBytes), mb(u.bandwidthBytes), u.transformations, u.resources];
				labels.forEach(([k, l, un], i) => items.push(this.ind(k, C, l, un, vals[i], `${S}${u.plan ? ` (خطة ${u.plan})` : ''}`, vals[i] === null ? 'لم يرجع المزوّد هذا الرقم' : undefined)));
			} catch (e) {
				for (const [k, l, u] of labels) items.push(this.ind(k, C, l, u, null, S, (e as Error)?.message === 'timeout' ? 'انتهت مهلة طلب المزوّد' : 'تعذّر الاتصال بالمزوّد أو رفض الطلب', 'error'));
			}
		}
		items.push(this.ind('cdn_hit_ratio', C, 'نسبة إصابة ذاكرة CDN المؤقتة', '%', null, 'لا مصدر', 'لا يوجد مزوّد CDN/Edge مرتبط يقيس نسبة الإصابة أو زمن التسليم؛ المطلوب ربط تقارير مزوّد التسليم'));
		this.cdnCache = { at: now, items };
		return items;
	}

	/** Read-only readiness of the AUTOMATIC support/dispute escalation. Evaluates every precondition on its own (even while the master switch is off) and changes nothing. */
	async escalationReadiness(env: NodeJS.ProcessEnv = process.env) {
		const readAt = this.deps.now().toISOString();
		const enabled = env.CASE_SLA_ENABLED === 'true';
		const fromRaw = env.CASE_SLA_FROM ?? '';
		const fromOk = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/.test(fromRaw) && Number.isFinite(new Date(fromRaw).getTime());
		const hoursRaw = env.SUPPORT_SLA_FIRST_REPLY_HOURS;
		const hoursList = hoursRaw ? hoursRaw.split(',').map(Number) : null;
		const hoursOk = !!hoursList && hoursList.length === 4 && hoursList.every(h => Number.isFinite(h) && h >= 1 && h <= 720);
		const owner = async (id: string | undefined, perms: string[]) => {
			const t = id?.trim();
			if (!t) return { defined: false, holds: null as boolean | null };
			try { return { defined: true, holds: await assigneeHolds(t, perms) }; } catch { return { defined: true, holds: null }; }
		};
		const [sup, dis] = await Promise.all([owner(env.SUPPORT_SLA_TARGET_ADMIN_ID, SUPPORT_PERMISSIONS), owner(env.DISPUTE_SLA_TARGET_ADMIN_ID, DISPUTE_PERMISSIONS)]);
		const pre = (key: string, label: string, met: boolean | null, detail: string) => ({ key, label, met, detail });
		const holdsDetail = (o: { defined: boolean; holds: boolean | null }, perms: string[]) => !o.defined ? 'لا يوجد مسؤول معرّف' : o.holds === null ? 'تعذّر التحقق من الصلاحيات' : o.holds ? 'نشط ويملك الصلاحيات المطلوبة' : `غير نشط أو لا يملك: ${perms.join('، ')}`;
		const preconditions = [
			pre('support_owner', 'مسؤول تذاكر الدعم معرّف', sup.defined, sup.defined ? 'معرّف' : 'غير معرّف (SUPPORT_SLA_TARGET_ADMIN_ID)'),
			pre('support_perms', 'مسؤول الدعم يملك الصلاحيات المطلوبة', sup.defined ? sup.holds : false, holdsDetail(sup, SUPPORT_PERMISSIONS)),
			pre('disputes_owner', 'مسؤول النزاعات معرّف', dis.defined, dis.defined ? 'معرّف' : 'غير معرّف (DISPUTE_SLA_TARGET_ADMIN_ID)'),
			pre('disputes_perms', 'مسؤول النزاعات يملك الصلاحيات المطلوبة', dis.defined ? dis.holds : false, holdsDetail(dis, DISPUTE_PERMISSIONS)),
			pre('hours', 'مهل أول رد محددة صراحةً لكل أولوية', hoursOk, hoursOk ? 'محددة' : hoursRaw ? 'قيمة غير صالحة (أربع قيم بين 1 و720 ساعة)' : 'غير محددة؛ ستُطبَّق القيم الافتراضية 48/24/8/2 ساعة ما لم تُحدَّد'),
			pre('start_date', 'تاريخ بدء الاحتساب محدد', fromOk, fromOk ? 'محدد' : 'غير محدد أو غير صالح (CASE_SLA_FROM)'),
		];
		return {
			readAt, automaticEscalation: enabled ? 'configured_on' : 'closed', enabled,
			summary: enabled ? 'التصعيد الآلي مفعّل بإعدادات الخادم (لا يمكن تغييره من هذه الصفحة)' : 'التصعيد الآلي مقفول',
			ready: preconditions.every(p => p.met === true), preconditions,
			supportPermissions: SUPPORT_PERMISSIONS, disputePermissions: DISPUTE_PERMISSIONS,
			source: 'قراءة فقط من إعدادات الخادم وصلاحيات الحسابات؛ لا يُسند ولا يُجدول شيئًا',
		};
	}
}
export const technicalMonitoring = new TechnicalMonitoringService();
