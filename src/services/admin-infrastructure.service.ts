import fs from 'node:fs';
import { infrastructureActions } from './infrastructure-actions.service';
import os from 'node:os';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { prisma as defaultPrisma } from '../config/db';
import { requestMetricsSnapshot, startedAt } from './request-metrics';

/**
 * Real infrastructure facts for the «البنية التقنية» pages. Every figure says WHAT measured it (`source`: process | container | host | database | config | filesystem), WHEN (`measuredAt`)
 * and over WHICH scope (this backend process only / the shared database / the last N minutes). Container numbers (cgroup) are never presented as server numbers: inside a container the
 * host load average and memory are the HOST's, and are labelled so. Anything the platform has no source for is returned as `unavailable` with the NAMED missing requirement - never a sample number.
 */
export type Source = 'process' | 'container' | 'host' | 'database' | 'config' | 'filesystem' | 'backup-dir' | 'provider' | 'backup-agent';
export interface Item { label: string; value: string | number | boolean | null; unit?: string; note?: string }
export interface Section { title: string; source: Source; scope: string; measuredAt: string; items?: Item[]; table?: { columns: string[]; rows: Array<Array<string | number | null>> }; unavailable?: { reason: string; requirement: string } }
const now = () => new Date().toISOString();
const MB = 1024 * 1024; const mb = (n: number) => Math.round((n / MB) * 10) / 10;
const sec = (s: Section) => s;
const loop = monitorEventLoopDelay({ resolution: 20 }); loop.enable();
const readNum = (p: string) => { try { const v = fs.readFileSync(p, 'utf8').trim(); return v === 'max' ? null : Number(v); } catch { return undefined; } };

export function containerSection(): Section {
	const cur = readNum('/sys/fs/cgroup/memory.current') ?? readNum('/sys/fs/cgroup/memory/memory.usage_in_bytes'); const max = readNum('/sys/fs/cgroup/memory.max') ?? readNum('/sys/fs/cgroup/memory/memory.limit_in_bytes');
	if (cur === undefined) return { title: 'الحاوية (cgroup)', source: 'container', scope: 'حاوية هذا الخادم', measuredAt: now(), unavailable: { reason: 'لا يُقرأ cgroup داخل هذه البيئة (ليست حاوية Linux أو الوصول مغلق).', requirement: 'تشغيل الخلفية داخل حاوية Linux مع /sys/fs/cgroup مقروءًا' } };
	const cpu = (() => { try { const m = /usage_usec (\d+)/.exec(fs.readFileSync('/sys/fs/cgroup/cpu.stat', 'utf8')); return m ? Number(m[1]) / 1e6 : null; } catch { return null; } })();
	const huge = max !== null && max !== undefined && max > 2 ** 60;
	return { title: 'الحاوية (cgroup)', source: 'container', scope: 'حاوية هذا الخادم وحدها', measuredAt: now(), items: [{ label: 'ذاكرة الحاوية المستخدمة', value: cur === null ? null : mb(cur), unit: 'MB' }, { label: 'حد ذاكرة الحاوية', value: max === null || max === undefined || huge ? null : mb(max), unit: 'MB', note: max === null || huge ? 'بلا حد مضبوط' : undefined }, { label: 'زمن CPU التراكمي للحاوية', value: cpu === null ? null : Math.round(cpu), unit: 'ثانية' }] };
}
export function runtimeSection(io?: { engine?: { clientsCount?: number } } | null): Section {
	const m = process.memoryUsage(); const cu = process.cpuUsage();
	return { title: 'عملية الخلفية (Node)', source: 'process', scope: 'هذه النسخة من الخلفية فقط (لا تشمل نسخًا أخرى)', measuredAt: now(), items: [
		{ label: 'مدة التشغيل', value: Math.round(process.uptime()), unit: 'ثانية' }, { label: 'بدأت العملية', value: new Date(startedAt).toISOString() }, { label: 'إصدار Node', value: process.version },
		{ label: 'ذاكرة RSS', value: mb(m.rss), unit: 'MB' }, { label: 'Heap مستخدم', value: mb(m.heapUsed), unit: 'MB' }, { label: 'Heap إجمالي', value: mb(m.heapTotal), unit: 'MB' },
		{ label: 'CPU للعملية (مستخدم+نظام)', value: Math.round((cu.user + cu.system) / 1000), unit: 'ms تراكمي' },
		{ label: 'تأخر حلقة الأحداث (متوسط)', value: Math.round((loop.mean / 1e6) * 10) / 10, unit: 'ms' }, { label: 'تأخر حلقة الأحداث (p99)', value: Math.round((loop.percentile(99) / 1e6) * 10) / 10, unit: 'ms' },
		{ label: 'اتصالات Socket.IO المفتوحة', value: io?.engine?.clientsCount ?? null, note: 'على هذه النسخة فقط' }] };
}
export function hostSection(): Section {
	const l = os.loadavg(); return { title: 'الخادم المضيف', source: 'host', scope: 'الجهاز المضيف كما تراه الحاوية (قد يشمل خدمات أخرى عليه)', measuredAt: now(), items: [
		{ label: 'عدد أنوية CPU', value: os.cpus().length }, { label: 'متوسط الحمل 1/5/15 دقيقة', value: l.map(x => Math.round(x * 100) / 100).join(' / ') },
		{ label: 'الذاكرة الكلية للمضيف', value: mb(os.totalmem()), unit: 'MB' }, { label: 'الذاكرة الحرة للمضيف', value: mb(os.freemem()), unit: 'MB' }, { label: 'مدة تشغيل المضيف', value: Math.round(os.uptime()), unit: 'ثانية' }, { label: 'النظام', value: `${os.platform()} ${os.release()}` }] };
}
export function diskSection(dir = process.cwd()): Section {
	try { const s = fs.statfsSync(dir); const total = s.blocks * s.bsize, free = s.bavail * s.bsize; return { title: 'القرص', source: 'filesystem', scope: `نظام الملفات الذي يحتوي ${dir}`, measuredAt: now(), items: [{ label: 'الحجم الكلي', value: Math.round(total / MB / 1024 * 10) / 10, unit: 'GB' }, { label: 'المتاح', value: Math.round(free / MB / 1024 * 10) / 10, unit: 'GB' }, { label: 'نسبة الاستخدام', value: Math.round((1 - free / total) * 1000) / 10, unit: '%' }] }; }
	catch { return { title: 'القرص', source: 'filesystem', scope: dir, measuredAt: now(), unavailable: { reason: 'تعذّرت قراءة حالة القرص.', requirement: 'صلاحية قراءة نظام الملفات للعملية' } }; }
}

export class AdminInfrastructureService {
	constructor(private db: typeof defaultPrisma = defaultPrisma, private io: () => { engine?: { clientsCount?: number } } | null = () => null) {}

	async ping() { const t = process.hrtime.bigint(); try { await this.db.$queryRaw`SELECT 1`; return { ok: true, ms: Math.round(Number(process.hrtime.bigint() - t) / 1e5) / 10 }; } catch { return { ok: false, ms: null as number | null }; } }

	async servers() { const p = await this.ping(); return { measuredAt: now(), sections: [runtimeSection(this.io()), containerSection(), hostSection(), diskSection(), sec({ title: 'الاتصال بقاعدة البيانات', source: 'database', scope: 'الاتصال من هذه النسخة', measuredAt: now(), items: [{ label: 'الحالة', value: p.ok ? 'يستجيب' : 'لا يستجيب' }, { label: 'زمن استعلام SELECT 1', value: p.ms, unit: 'ms' }] })] }; }

	async database() {
		const out: Section[] = [];
		try {
			const [info] = await this.db.$queryRawUnsafe<Array<{ size: bigint; version: string; conns: number; active: number; idle: number; maxc: number }>>(`SELECT pg_database_size(current_database()) AS size, version() AS version, (SELECT count(*) FROM pg_stat_activity WHERE datname = current_database())::int AS conns, (SELECT count(*) FROM pg_stat_activity WHERE datname = current_database() AND state = 'active')::int AS active, (SELECT count(*) FROM pg_stat_activity WHERE datname = current_database() AND state = 'idle')::int AS idle, current_setting('max_connections')::int AS maxc`);
			out.push({ title: 'قاعدة البيانات', source: 'database', scope: 'قاعدة هذا البيئة المشتركة بين كل نسخ الخلفية', measuredAt: now(), items: [{ label: 'الإصدار', value: String(info.version).split(' on ')[0] }, { label: 'حجم القاعدة', value: mb(Number(info.size)), unit: 'MB' }, { label: 'الاتصالات الكلية', value: info.conns, note: `الحد ${info.maxc}` }, { label: 'اتصالات نشطة', value: info.active }, { label: 'اتصالات خاملة', value: info.idle }] });
			const t = await this.db.$queryRawUnsafe<Array<{ name: string; size: bigint; rows: bigint }>>(`SELECT relname AS name, pg_total_relation_size(c.oid) AS size, reltuples::bigint AS rows FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relkind = 'r' ORDER BY pg_total_relation_size(c.oid) DESC LIMIT 15`);
			out.push({ title: 'أكبر الجداول', source: 'database', scope: 'مخطط public (عدد الصفوف تقديري من إحصاءات PostgreSQL)', measuredAt: now(), table: { columns: ['الجدول', 'الحجم (MB)', 'الصفوف (تقديري)'], rows: t.map(r => [r.name, mb(Number(r.size)), Number(r.rows)]) } });
			const mig = await this.db.$queryRawUnsafe<Array<{ n: number; last: string | null }>>(`SELECT count(*)::int AS n, max(migration_name) AS last FROM _prisma_migrations WHERE finished_at IS NOT NULL`).catch(() => null);
			out.push(mig ? { title: 'سجل الـ migrations', source: 'database', scope: 'جدول _prisma_migrations', measuredAt: now(), items: [{ label: 'migrations المسجّلة كمطبّقة', value: mig[0].n }, { label: 'آخر migration', value: mig[0].last }], } : { title: 'سجل الـ migrations', source: 'database', scope: '_prisma_migrations', measuredAt: now(), unavailable: { reason: 'الجدول غير موجود أو غير مقروء (بعض البيئات تطبّق الـ migrations يدويًا ولا تحدّثه).', requirement: 'جدول _prisma_migrations محدَّث' } });
		} catch (e) { out.push({ title: 'قاعدة البيانات', source: 'database', scope: 'هذه البيئة', measuredAt: now(), unavailable: { reason: `تعذّر الاستعلام: ${(e as Error).message.slice(0, 120)}`, requirement: 'اتصال سليم بقاعدة البيانات' } }); }
		return { measuredAt: now(), sections: out };
	}

	performance() { const snap = requestMetricsSnapshot(); return { measuredAt: now(), sections: [
		{ title: 'الطلبات (آخر ' + snap.windowMinutes + ' دقيقة)', source: 'process' as const, scope: 'هذه النسخة من الخلفية فقط؛ تتصفّر عند إعادة تشغيلها', measuredAt: now(), items: [{ label: 'إجمالي الطلبات', value: snap.totals.requests }, { label: 'أخطاء الخادم 5xx', value: snap.totals.errors5xx }, { label: 'أخطاء العميل 4xx', value: snap.totals.errors4xx }, { label: 'بداية النافذة', value: snap.since }] },
		{ title: 'أبطأ/أكثر المسارات طلبًا', source: 'process' as const, scope: 'مجمّعة حسب الطريقة وأول مقطعين من المسار؛ p50/p95 حدّ أعلى لشريحة زمنية', measuredAt: now(), table: { columns: ['المسار', 'طلبات', '4xx', '5xx', 'متوسط ms', 'p50 ≤ ms', 'p95 ≤ ms'], rows: snap.groups.map(g => [g.group, g.requests, g.errors4xx, g.errors5xx, g.avgMs, g.p50MsUpperBound ?? '> 5000', g.p95MsUpperBound ?? '> 5000']) } },
		runtimeSection(this.io())] }; }

	apis() { const env = (k: string) => !!process.env[k]; return { measuredAt: now(), sections: [
		{ title: 'التكاملات (حالة التهيئة فقط)', source: 'config' as const, scope: 'متغيرات بيئة هذه النسخة؛ لا اتصال فعليًا بالمزوّد', measuredAt: now(), items: [
			{ label: 'PayPal', value: env('PAYPAL_CLIENT_ID') && env('PAYPAL_CLIENT_SECRET') ? 'مُهيّأ' : 'غير مُهيّأ' }, { label: 'البريد (SMTP)', value: env('SMTP_HOST') && env('SMTP_USER') && env('SMTP_PASS') ? 'مُهيّأ' : 'غير مُهيّأ' },
			{ label: 'بوابة وسيط AI', value: process.env.WASEET_AI_GATEWAY_ENABLED === 'true' && env('WASEET_AI_BASE_URL') ? 'مفعّلة' : 'غير مفعّلة' }, { label: 'GeoIP (اقتراح الدولة/المدينة)', value: (process.env.GEOIP_PROVIDER && env('GEOIP_TOKEN')) || process.env.GEOIP_TRUST_CDN_HEADERS ? 'مُهيّأ' : 'غير مُهيّأ' }] },
		{ title: 'واجهات الـ API حسب المسار', source: 'process' as const, scope: 'آخر 15 دقيقة على هذه النسخة', measuredAt: now(), table: { columns: ['المسار', 'طلبات', '5xx', 'متوسط ms'], rows: requestMetricsSnapshot().groups.map(g => [g.group, g.requests, g.errors5xx, g.avgMs]) } }] }; }

	async cdn() {
		const rows = await this.db.$queryRawUnsafe<Array<{ n: number; bytes: bigint | null }>>(`SELECT count(*)::int AS n, coalesce(sum(length(bytes)), 0)::bigint AS bytes FROM site_identity_assets WHERE status = 'PUBLISHED'`).catch(() => null);
		let provider: Section;
        try { const c = await infrastructureActions.cdn.status(); provider = { title: 'شبكة توصيل المحتوى (CDN)', source: 'provider', scope: `Cloudflare zone: ${c.name} · ${c.since} — ${c.until}`, measuredAt: now(), items: [{label:'حالة النطاق',value:c.status},{label:'طلبات آخر 24 ساعة كاملة',value:c.analytics?.requests ?? null},{label:'نسبة إصابة الكاش',value:c.analytics && c.analytics.requests ? Math.round(c.analytics.cachedRequests/c.analytics.requests*10000)/100 : null,unit:'%',note:c.analytics?'من عدادات Cloudflare':'يلزم رمز بصلاحية Analytics Read وخطة تدعم البيانات'},{label:'حجم البيانات',value:c.analytics?.bytes ?? null,unit:'bytes'}] }; } catch { provider = {title:'شبكة توصيل المحتوى (CDN)',source:'provider',scope:'Cloudflare',measuredAt:now(),unavailable:{reason:'التكامل غير مهيأ أو تعذر الاتصال بالمزوّد.',requirement:'CDN_PROVIDER=cloudflare + CDN_API_TOKEN (Zone Read, Analytics Read, Cache Purge) + CDN_ZONE_ID'}}; }
		return { measuredAt: now(), sections: [
			rows ? { title: 'أصول الهوية المنشورة (من قاعدة البيانات)', source: 'database' as const, scope: 'الأصول التي تخدمها المنصة نفسها', measuredAt: now(), items: [{ label: 'عدد الأصول المنشورة', value: rows[0].n }, { label: 'حجمها الكلي', value: Math.round(Number(rows[0].bytes ?? 0) / 1024), unit: 'KB' }] } : { title: 'أصول الهوية', source: 'database' as const, scope: 'site_identity_assets', measuredAt: now(), unavailable: { reason: 'الجدول غير مقروء.', requirement: 'ترحيل الهوية مطبّق' } },
            provider] };
	}

 async backups() {
  try { const b = await infrastructureActions.backup.call('/files'); return { measuredAt:now(), sections:[{title:'النسخ الاحتياطي',source:'backup-agent' as const,scope:'عامل النسخ — الاسترداد إلى قاعدة منفصلة فقط',measuredAt:now(),items:[{label:'قاعدة الاسترداد مهيأة',value:!!b.recoveryConfigured}],table:{columns:['الملف','الحجم (MB)','التاريخ','SHA256'],rows:b.files.map((f:any)=>[f.file,mb(f.bytes),f.at,f.sha256])}}] }; }
  catch { return {measuredAt:now(),sections:[{title:'النسخ الاحتياطي',source:'backup-agent' as const,scope:'عامل نسخ منفصل عن خادم التطبيق',measuredAt:now(),unavailable:{reason:'عامل النسخ غير مهيأ أو لا يستجيب.',requirement:'BACKUP_AGENT_URL + BACKUP_AGENT_TOKEN؛ العامل: BACKUP_DIR + SOURCE_DATABASE_URL، وللاسترداد RESTORE_DATABASE_URL لقاعدة منفصلة'}}]}; }
 }
}
export const adminInfrastructureService = new AdminInfrastructureService(defaultPrisma, () => { try { return (require('../socket') as { getIO: () => never }).getIO(); } catch { return null; } });
