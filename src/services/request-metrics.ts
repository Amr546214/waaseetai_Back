import type { NextFunction, Request, Response } from 'express';

/**
 * Rolling per-process request metrics for the Performance / APIs pages: the last 15 minutes in one-minute buckets, grouped by method + the first two path segments (ids collapsed).
 * It measures THIS backend process only (with several instances each answers for itself; the response says so). Memory is bounded: at most MAX_GROUPS groups.
 */
const BUCKET_MS = 60_000, BUCKETS = 15, MAX_GROUPS = 200;
const EDGES = [25, 50, 100, 250, 500, 1000, 2500, 5000]; // ms upper bounds; the last bucket is "slower"
interface Bucket { minute: number; n: number; e4: number; e5: number; ms: number; h: number[] }
const groups = new Map<string, Bucket[]>();
export const startedAt = Date.now();
export const groupOf = (method: string, path: string) => `${method} ${path.replace(/^\/api(?=\/)/, '').split('?')[0].split('/').filter(Boolean).slice(0, 2).map(s => (/^[0-9a-f-]{8,}$/i.test(s) || /^\d+$/.test(s) ? ':id' : s)).join('/') || '/'}`;
export function recordRequest(method: string, path: string, status: number, ms: number, now = Date.now()): void {
	const key = groupOf(method, path); let arr = groups.get(key);
	if (!arr) { if (groups.size >= MAX_GROUPS) return; arr = []; groups.set(key, arr); }
	const minute = Math.floor(now / BUCKET_MS); let b = arr[arr.length - 1];
	if (!b || b.minute !== minute) { b = { minute, n: 0, e4: 0, e5: 0, ms: 0, h: new Array(EDGES.length + 1).fill(0) }; arr.push(b); while (arr.length > BUCKETS) arr.shift(); }
	b.n++; b.ms += ms; if (status >= 500) b.e5++; else if (status >= 400) b.e4++; b.h[Math.max(0, EDGES.findIndex(e => ms <= e) === -1 ? EDGES.length : EDGES.findIndex(e => ms <= e))]++;
}
export const requestMetricsMiddleware = (req: Request, res: Response, next: NextFunction) => {
	const t = process.hrtime.bigint(); res.once('finish', () => { try { recordRequest(req.method, req.originalUrl || req.path, res.statusCode, Number(process.hrtime.bigint() - t) / 1e6); } catch { /* metrics never break a request */ } });
	next();
};
const pct = (h: number[], total: number, p: number) => { if (!total) return null; let acc = 0; for (let i = 0; i < h.length; i++) { acc += h[i]; if (acc >= total * p) return i < EDGES.length ? EDGES[i] : EDGES[EDGES.length - 1]; } return null; };
/** p50/p95 are the upper edge of the histogram bucket that holds the percentile (an upper bound, not an exact value) */
export function requestMetricsSnapshot(now = Date.now()) {
	const min = Math.floor(now / BUCKET_MS) - BUCKETS + 1; const rows: Array<{ group: string; requests: number; errors4xx: number; errors5xx: number; avgMs: number; p50MsUpperBound: number | null; p95MsUpperBound: number | null }> = [];
	for (const [group, arr] of groups) {
		const bs = arr.filter(b => b.minute >= min); const n = bs.reduce((a, b) => a + b.n, 0); if (!n) continue; const h = EDGES.map((_, i) => bs.reduce((a, b) => a + b.h[i], 0)); h.push(bs.reduce((a, b) => a + b.h[EDGES.length], 0));
		rows.push({ group, requests: n, errors4xx: bs.reduce((a, b) => a + b.e4, 0), errors5xx: bs.reduce((a, b) => a + b.e5, 0), avgMs: Math.round(bs.reduce((a, b) => a + b.ms, 0) / n), p50MsUpperBound: pct(h, n, 0.5), p95MsUpperBound: pct(h, n, 0.95) });
	}
	rows.sort((a, b) => b.requests - a.requests);
	return { windowMinutes: BUCKETS, since: new Date(Math.max(startedAt, min * BUCKET_MS)).toISOString(), groups: rows.slice(0, 40), totals: { requests: rows.reduce((a, r) => a + r.requests, 0), errors5xx: rows.reduce((a, r) => a + r.errors5xx, 0), errors4xx: rows.reduce((a, r) => a + r.errors4xx, 0) } };
}
export const resetRequestMetrics = () => groups.clear();
