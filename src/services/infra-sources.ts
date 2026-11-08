import { readFile, statfs } from 'node:fs/promises';
import { z } from 'zod';

/**
 * Infrastructure readings, each labelled with its SCOPE:
 *  - what the app can really see from INSIDE its container (cgroup memory/cpu files, the filesystem that holds the app directory): scope = this container only, never "the server";
 *  - optional adapters for sources the infra team may provide (host metrics, container state/restarts, CDN edge statistics, WAF), configured ONLY by environment variable names, allow-listed by host,
 *    short timeout, response-size cap, schema-validated, cached, and «غير متاح» when not configured.
 * Read-only. No value is ever estimated.
 */
export type Raw = { key: string; group: 'infra' | 'cdn'; label: string; unit: string; value: number | null; status: 'measured' | 'unavailable' | 'error'; readAt: string; source: string; scope: string; reason?: string };
export type InfraDeps = { cgroupRoot: string; diskPath: () => string; fetchImpl: typeof fetch; now: () => Date; env: NodeJS.ProcessEnv };
const MAX_BODY = 16 * 1024, FETCH_TIMEOUT_MS = 3_000, ADAPTER_CACHE_MS = 60_000, ADAPTER_STALE_MS = 15 * 60_000;
const round = (n: number, d = 1) => Math.round(n * 10 ** d) / 10 ** d;
const MB = 1048576, GB = 1073741824;

export const defaultInfraDeps = (): InfraDeps => ({ cgroupRoot: '/sys/fs/cgroup', diskPath: () => process.env.MONITOR_DISK_PATH || process.cwd(), fetchImpl: fetch, now: () => new Date(), env: process.env });

const iso = z.string().datetime({ offset: true });
const nonNeg = z.number().finite().nonnegative();
const host = z.object({ schemaVersion: z.literal(1), collectedAt: iso, scope: z.string().min(1).max(80), cpuPercent: z.number().min(0).max(100).optional(), memoryUsedBytes: nonNeg.optional(), memoryTotalBytes: nonNeg.optional(), diskUsedBytes: nonNeg.optional(), diskTotalBytes: nonNeg.optional() }).strict();
const containers = z.object({ schemaVersion: z.literal(1), collectedAt: iso, containers: z.array(z.object({ name: z.string().max(64), state: z.enum(['running', 'restarting', 'exited', 'paused', 'dead', 'created']), restartCount: z.number().int().nonnegative() }).strict()).max(50) }).strict();
const edge = z.object({ schemaVersion: z.literal(1), collectedAt: iso, windowMinutes: z.number().positive().max(1440), requests: nonNeg, cacheHitRatioPercent: z.number().min(0).max(100) }).strict();
const waf = z.object({ schemaVersion: z.literal(1), collectedAt: iso, windowMinutes: z.number().positive().max(1440), blockedRequests: nonNeg, challengedRequests: nonNeg.optional() }).strict();

type Adapter = 'host' | 'containers' | 'edge' | 'waf';
const ADAPTERS: Record<Adapter, { url: string; token: string; schema: z.ZodType<any>; need: string }> = {
	host: { url: 'HOST_METRICS_URL', token: 'HOST_METRICS_TOKEN', schema: host, need: 'HOST_METRICS_URL (نقطة JSON لمقاييس المضيف)' },
	containers: { url: 'CONTAINER_STATUS_URL', token: 'CONTAINER_STATUS_TOKEN', schema: containers, need: 'CONTAINER_STATUS_URL (نقطة JSON لحالة الحاويات وإعادة تشغيلها)' },
	edge: { url: 'EDGE_STATS_URL', token: 'EDGE_STATS_TOKEN', schema: edge, need: 'EDGE_STATS_URL (نقطة JSON لإحصاءات الحافة/CDN)' },
	waf: { url: 'WAF_STATUS_URL', token: 'WAF_STATUS_TOKEN', schema: waf, need: 'WAF_STATUS_URL (نقطة JSON لحالة جدار الحماية)' },
};

export class InfraSources {
	deps: InfraDeps = defaultInfraDeps();
	private prevCpu: { usageUs: number; at: number } | null = null;
	private cache = new Map<Adapter, { at: number; data: any; error?: string }>();
	reset() { this.prevCpu = null; this.cache.clear(); }

	private mk(key: string, group: Raw['group'], label: string, unit: string, value: number | null, source: string, scope: string, reason?: string, status?: Raw['status'], readAt?: string): Raw {
		return { key, group, label, unit, value, status: status ?? (value === null ? 'unavailable' : 'measured'), readAt: readAt ?? this.deps.now().toISOString(), source, scope, ...(reason ? { reason } : {}) };
	}

	/** what this container can see: memory and CPU from the cgroup files, disk from the filesystem holding the app directory */
	async container(): Promise<Raw[]> {
		const S = 'cgroup / statfs داخل الحاوية', C = 'حاوية الباك فقط (ليس المضيف ولا بقية الخدمات)';
		const root = this.deps.cgroupRoot; const num = async (p: string) => { const t = (await readFile(`${root}/${p}`, 'utf8')).trim(); return t === 'max' ? Infinity : Number(t); };
		const out: Raw[] = [];
		let memUsed: number | null = null, memLimit = Infinity, v2 = true;
		try { memUsed = await num('memory.current'); memLimit = await num('memory.max'); }
		catch { try { v2 = false; memUsed = await num('memory/memory.usage_in_bytes'); memLimit = await num('memory/memory.limit_in_bytes'); if (memLimit > 2 ** 60) memLimit = Infinity; } catch { memUsed = null; } }
		const noCg = 'ملفات cgroup غير مقروءة (التطبيق لا يعمل داخل حاوية، أو بيئة التشغيل لا تعرضها)';
		out.push(this.mk('ctr_mem_used', 'infra', 'ذاكرة الحاوية المستخدمة', 'MB', memUsed !== null && Number.isFinite(memUsed) ? round(memUsed / MB) : null, S, C, memUsed === null ? noCg : undefined));
		out.push(this.mk('ctr_mem_limit_pct', 'infra', 'نسبة ذاكرة الحاوية من حدّها', '%', memUsed !== null && Number.isFinite(memLimit) && memLimit > 0 ? round((memUsed / memLimit) * 100) : null, S, C, memUsed === null ? noCg : Number.isFinite(memLimit) ? undefined : 'الحاوية بلا حد ذاكرة مضبوط'));
		let usageUs: number | null = null;
		try { if (v2) { const t = await readFile(`${root}/cpu.stat`, 'utf8'); const m = /usage_usec\s+(\d+)/.exec(t); usageUs = m ? Number(m[1]) : null; } else usageUs = (await num('cpuacct/cpuacct.usage')) / 1000; } catch { usageUs = null; }
		const now = this.deps.now().getTime(); let cpu: number | null = null, cpuReason: string | undefined;
		if (usageUs === null || !Number.isFinite(usageUs)) cpuReason = noCg;
		else if (!this.prevCpu || now <= this.prevCpu.at) cpuReason = 'يحتاج قراءتين متتاليتين لحساب المعدل؛ أعد التحديث بعد قليل';
		else { cpu = round(((usageUs - this.prevCpu.usageUs) / ((now - this.prevCpu.at) * 1000)) * 100); if (cpu < 0) { cpu = null; cpuReason = 'أُعيد ضبط عدّاد المعالج؛ أعد التحديث'; } }
		if (usageUs !== null && Number.isFinite(usageUs)) this.prevCpu = { usageUs, at: now };
		out.push(this.mk('ctr_cpu', 'infra', 'استخدام معالج الحاوية (نواة واحدة = 100%)', '%', cpu, `${S}؛ متوسط الفترة بين قراءتين متتاليتين`, C, cpuReason));
		const D = 'نظام الملفات الذي يحوي مجلد التطبيق داخل الحاوية (وليس المضيف كاملًا)';
		try {
			const s = await statfs(this.deps.diskPath()); const total = s.blocks * s.bsize, free = s.bavail * s.bsize;
			out.push(this.mk('ctr_disk_used_pct', 'infra', 'امتلاء نظام ملفات التطبيق', '%', total > 0 ? round(((total - free) / total) * 100) : null, S, D, total > 0 ? undefined : 'الحجم الكلي غير معروف'));
			out.push(this.mk('ctr_disk_free', 'infra', 'المساحة الحرة في نظام ملفات التطبيق', 'GB', round(free / GB, 2), S, D));
		} catch {
			for (const [k, l, u] of [['ctr_disk_used_pct', 'امتلاء نظام ملفات التطبيق', '%'], ['ctr_disk_free', 'المساحة الحرة في نظام ملفات التطبيق', 'GB']]) out.push(this.mk(k, 'infra', l, u, null, S, D, 'تعذّرت قراءة نظام الملفات', 'error'));
		}
		return out;
	}

	private async fetchJson(name: Adapter): Promise<{ data?: any; reason?: string; error?: boolean }> {
		const a = ADAPTERS[name], env = this.deps.env, raw = env[a.url]?.trim();
		if (!raw) return { reason: `المصدر غير مهيأ؛ يلزم من فريق البنية توفير ${a.need}` };
		const hit = this.cache.get(name), now = this.deps.now().getTime();
		if (hit && now - hit.at < ADAPTER_CACHE_MS) return hit.error ? { reason: hit.error, error: true } : { data: hit.data };
		const fail = (reason: string) => { this.cache.set(name, { at: now, data: null, error: reason }); return { reason, error: true }; };
		let url: URL;
		try { url = new URL(raw); } catch { return fail('عنوان المصدر غير صالح'); }
		const allowed = (env.MONITORING_ALLOWED_HOSTS ?? '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
		if (!/^https?:$/.test(url.protocol) || !allowed.includes(url.host.toLowerCase())) return fail('عنوان المصدر خارج القائمة المسموحة (MONITORING_ALLOWED_HOSTS)');
		const ac = new AbortController(); const t = setTimeout(() => ac.abort(), FETCH_TIMEOUT_MS);
		try {
			const token = env[a.token]?.trim();
			const res = await this.deps.fetchImpl(url, { signal: ac.signal, redirect: 'error', headers: { accept: 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) } });
			if (!res.ok) return fail('رفض المصدر الطلب أو لم يستجب بنجاح');
			if (!/json/i.test(res.headers.get('content-type') ?? '')) return fail('ردّ المصدر ليس JSON');
			const len = Number(res.headers.get('content-length') ?? 0); if (len > MAX_BODY) return fail('ردّ المصدر أكبر من الحد المسموح');
			const reader = res.body?.getReader(); if (!reader) return fail('ردّ المصدر فارغ');
			const chunks: Uint8Array[] = []; let size = 0;
			for (;;) { const { done, value } = await reader.read(); if (done) break; size += value.byteLength; if (size > MAX_BODY) { void reader.cancel(); return fail('ردّ المصدر أكبر من الحد المسموح'); } chunks.push(value); }
			const parsed = a.schema.safeParse(JSON.parse(Buffer.concat(chunks).toString('utf8')));
			if (!parsed.success) return fail('ردّ المصدر لا يطابق العقد المتفق عليه');
			const collected = Date.parse(parsed.data.collectedAt);
			if (collected > now + 5 * 60_000) return fail('وقت المصدر في المستقبل');
			this.cache.set(name, { at: now, data: parsed.data }); return { data: parsed.data };
		} catch { return fail('تعذّر الاتصال بالمصدر أو انتهت المهلة'); }
		finally { clearTimeout(t); }
	}

	private stale(collectedAt: string) { return this.deps.now().getTime() - Date.parse(collectedAt) > ADAPTER_STALE_MS; }

	async external(): Promise<Raw[]> {
		const out: Raw[] = [], now = () => this.deps.now().toISOString();
		const staleReason = 'المصدر لم يحدّث بياناته منذ أكثر من ١٥ دقيقة';
		const put = (key: string, group: Raw['group'], label: string, unit: string, r: { data?: any; reason?: string; error?: boolean }, pick: (d: any) => number | undefined, source: string, scope: (d: any) => string, fallbackScope: string) => {
			if (!r.data) { out.push(this.mk(key, group, label, unit, null, source, fallbackScope, r.reason, r.error ? 'error' : 'unavailable')); return; }
			const v = pick(r.data);
			if (v === undefined) out.push(this.mk(key, group, label, unit, null, source, scope(r.data), 'المصدر لم يرسل هذا الحقل', 'unavailable', r.data.collectedAt));
			else if (this.stale(r.data.collectedAt)) out.push(this.mk(key, group, label, unit, null, source, scope(r.data), staleReason, 'unavailable', r.data.collectedAt));
			else out.push(this.mk(key, group, label, unit, v, source, scope(r.data), undefined, 'measured', r.data.collectedAt));
		};
		const h = await this.fetchJson('host'), HS = 'مصدر مقاييس المضيف الخارجي (HOST_METRICS_URL)', hs = (d: any) => d.scope, hf = 'المضيف (المصدر غير مهيأ)';
		put('host_cpu', 'infra', 'استخدام معالج المضيف', '%', h, d => d.cpuPercent, HS, hs, hf);
		put('host_mem_pct', 'infra', 'نسبة ذاكرة المضيف المستخدمة', '%', h, d => (d.memoryUsedBytes !== undefined && d.memoryTotalBytes > 0 ? round((d.memoryUsedBytes / d.memoryTotalBytes) * 100) : undefined), HS, hs, hf);
		put('host_disk_pct', 'infra', 'نسبة امتلاء قرص المضيف', '%', h, d => (d.diskUsedBytes !== undefined && d.diskTotalBytes > 0 ? round((d.diskUsedBytes / d.diskTotalBytes) * 100) : undefined), HS, hs, hf);
		const c = await this.fetchJson('containers'), CS = 'مصدر حالة الحاويات الخارجي (CONTAINER_STATUS_URL)', cs = (d: any) => `${d.containers.length} حاوية يغطيها المصدر`, cf = 'الحاويات (المصدر غير مهيأ)';
		put('ctr_running', 'infra', 'حاويات تعمل', 'حاوية', c, d => d.containers.filter((x: any) => x.state === 'running').length, CS, cs, cf);
		put('ctr_not_running', 'infra', 'حاويات لا تعمل أو تُعاد', 'حاوية', c, d => d.containers.filter((x: any) => x.state !== 'running').length, CS, cs, cf);
		put('ctr_restarts', 'infra', 'مجموع إعادات تشغيل الحاويات', 'مرة', c, d => d.containers.reduce((s: number, x: any) => s + x.restartCount, 0), CS, cs, cf);
		const e = await this.fetchJson('edge'), ES = 'مصدر إحصاءات الحافة الخارجي (EDGE_STATS_URL)', es = (d: any) => `طبقة الحافة/CDN، آخر ${d.windowMinutes} دقيقة`, ef = 'طبقة الحافة (المصدر غير مهيأ)';
		put('edge_requests', 'cdn', 'طلبات الحافة', 'طلب', e, d => d.requests, ES, es, ef);
		put('edge_hit_ratio', 'cdn', 'نسبة إصابة ذاكرة الحافة المؤقتة', '%', e, d => d.cacheHitRatioPercent, ES, es, ef);
		const w = await this.fetchJson('waf'), WS = 'مصدر جدار الحماية الخارجي (WAF_STATUS_URL)', ws = (d: any) => `جدار الحماية، آخر ${d.windowMinutes} دقيقة`, wf = 'جدار الحماية (المصدر غير مهيأ)';
		put('waf_blocked', 'infra', 'طلبات حجبها جدار الحماية', 'طلب', w, d => d.blockedRequests, WS, ws, wf);
		void now;
		return out;
	}
}
export const infraSources = new InfraSources();
