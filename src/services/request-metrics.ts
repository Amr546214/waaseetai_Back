import { monitorEventLoopDelay } from 'node:perf_hooks';
import type { NextFunction, Request, Response } from 'express';

/**
 * In-process, rolling-window request aggregates for the technical monitoring page. Stores ONLY counters per minute:
 * no path, no query, no user, no address. One bucket per minute, the last WINDOW_MINUTES kept. Per process: a second instance has its own numbers.
 */
export const WINDOW_MINUTES = 15;
/** upper edges (ms) of the latency histogram; a percentile is reported as the upper edge of the bucket that holds it (an upper bound, not an interpolation) */
export const LATENCY_EDGES = [10, 25, 50, 100, 250, 500, 1000, 2500, 5000] as const;
const SLOTS = LATENCY_EDGES.length + 1;
type Bucket = { minute: number; total: number; s2: number; s3: number; s4: number; s5: number; s429: number; lat: number[] };

export class RequestMetrics {
	private buckets = new Map<number, Bucket>();
	readonly startedAt: number;
	constructor(private now: () => number = Date.now) { this.startedAt = now(); }

	record(status: number, ms: number) {
		const minute = Math.floor(this.now() / 60_000);
		let b = this.buckets.get(minute);
		if (!b) {
			b = { minute, total: 0, s2: 0, s3: 0, s4: 0, s5: 0, s429: 0, lat: new Array(SLOTS).fill(0) };
			this.buckets.set(minute, b);
			for (const k of this.buckets.keys()) if (k <= minute - WINDOW_MINUTES) this.buckets.delete(k);
		}
		b.total++;
		const cls = Math.floor(status / 100);
		if (cls === 2) b.s2++; else if (cls === 3) b.s3++; else if (cls === 4) b.s4++; else if (cls === 5) b.s5++;
		if (status === 429) b.s429++;
		let i = LATENCY_EDGES.findIndex(e => ms <= e); if (i < 0) i = SLOTS - 1;
		b.lat[i]++;
	}

	/** aggregates over the last WINDOW_MINUTES (the current partial minute included) */
	snapshot() {
		const minute = Math.floor(this.now() / 60_000);
		const acc = { total: 0, s2: 0, s3: 0, s4: 0, s5: 0, s429: 0, lat: new Array(SLOTS).fill(0) as number[] };
		for (const b of this.buckets.values()) {
			if (b.minute <= minute - WINDOW_MINUTES) continue;
			acc.total += b.total; acc.s2 += b.s2; acc.s3 += b.s3; acc.s4 += b.s4; acc.s5 += b.s5; acc.s429 += b.s429;
			b.lat.forEach((n, i) => { acc.lat[i] += n; });
		}
		const coveredMinutes = Math.min(WINDOW_MINUTES, Math.max(1, Math.ceil((this.now() - this.startedAt) / 60_000)));
		const pct = (p: number): { ms: number; capped: boolean } | null => {
			if (!acc.total) return null;
			const need = Math.ceil(acc.total * p); let run = 0;
			for (let i = 0; i < SLOTS; i++) { run += acc.lat[i]; if (run >= need) return i < LATENCY_EDGES.length ? { ms: LATENCY_EDGES[i], capped: false } : { ms: LATENCY_EDGES[LATENCY_EDGES.length - 1], capped: true }; }
			return null;
		};
		return { ...acc, coveredMinutes, p50: pct(0.5), p95: pct(0.95), p99: pct(0.99) };
	}
	reset() { this.buckets.clear(); }
}

export const requestMetrics = new RequestMetrics();

export function requestMetricsMiddleware(req: Request, res: Response, next: NextFunction) {
	const t0 = process.hrtime.bigint();
	res.once('finish', () => requestMetrics.record(res.statusCode, Number(process.hrtime.bigint() - t0) / 1e6));
	next();
}

/** event-loop delay since the last reset (the service resets it on a slow cadence so the figure covers a few minutes, not the whole uptime) */
const loop = monitorEventLoopDelay({ resolution: 20 });
let loopOn = false; let loopSince = Date.now();
export function eventLoopDelay(now = Date.now(), maxAgeMs = 5 * 60_000): { p99Ms: number; sinceMs: number } | null {
	if (!loopOn) { loop.enable(); loopOn = true; loopSince = now; return null; }
	if (loop.count === 0) return null;
	const out = { p99Ms: Math.round((loop.percentile(99) / 1e6) * 10) / 10, sinceMs: now - loopSince };
	if (now - loopSince > maxAgeMs) { loop.reset(); loopSince = now; }
	return out;
}
export function startEventLoopSampling() { if (!loopOn) { loop.enable(); loopOn = true; loopSince = Date.now(); } }
