import { createHash } from 'node:crypto';
import { prisma as defaultPrisma } from '../config/db';
import { logger } from '../config/logger';
import { systemSettingsService } from './system-settings.service';
import { isMissingTableError } from '../utils/missing-table';

/**
 * Configurable login protection (registry keys loginMaxFailedAttempts / loginAttemptWindowMinutes / loginBlockMinutes / loginIpMaxFailedAttempts, SUPER_ADMIN only).
 * Two scopes, deliberately different:
 *  - PAIR  = this ADDRESS + this ACCOUNT. Protects the account against guessing from that address. It never blocks the account for anybody else, so an unknown attacker
 *            cannot lock a real user out: the owner on another address is untouched (the existing per-account progressive delay stays as the all-addresses layer).
 *  - IP    = this ADDRESS across ALL accounts. Protects the address from trying many accounts (credential stuffing). Counts only failures, whatever the account.
 * Only a real credential failure (HTTP 401 from the login endpoints) counts; a success, a validation error or a 429 does not. A success clears the pair counter (never the IP one).
 * The state lives in the database (login_guard_state), so every backend instance sees the same counters and blocks; the thresholds are read per attempt from the settings service,
 * so a new value applies immediately without a deploy. The address is the one Express derived from the configured trust-proxy boundary (IPv4-mapped IPv6 normalised, IPv6 collapsed to /56).
 * Storage failure => fail OPEN (logged): the normal password checks and the rate limiters still apply.
 */
export type LoginGuardConfig = { maxFails: number; windowMin: number; blockMin: number; ipMaxFails: number };
export type GuardKey = { ip: string; email?: string };
export type BlockVerdict = { blocked: false } | { blocked: true; scope: 'PAIR' | 'IP'; retryAfterSeconds: number };
const sha = (s: string) => createHash('sha256').update(s).digest('hex').slice(0, 32);
export const normalizeIp = (ip: string | undefined) => { const v = (ip || '').trim().toLowerCase(); return v.startsWith('::ffff:') && v.includes('.') ? v.slice(7) : v; };
export const maskEmail = (email: string) => { const [u, d] = email.split('@'); return d ? `${u.slice(0, 1)}***@${d}` : '***'; };
const pairKey = (k: GuardKey) => `p:${normalizeIp(k.ip)}|${sha((k.email || '').trim().toLowerCase())}`;
const ipKey = (k: GuardKey) => `i:${normalizeIp(k.ip)}`;

export class LoginGuardService {
	constructor(private db: typeof defaultPrisma = defaultPrisma) {}

	async config(): Promise<LoginGuardConfig> {
		const g = (k: string) => systemSettingsService.get<number>(k);
		const [maxFails, windowMin, blockMin, ipMaxFails] = await Promise.all([g('loginMaxFailedAttempts'), g('loginAttemptWindowMinutes'), g('loginBlockMinutes'), g('loginIpMaxFailedAttempts')]);
		return { maxFails, windowMin, blockMin, ipMaxFails };
	}

	async check(k: GuardKey): Promise<BlockVerdict> {
		try {
			const keys = k.email ? [pairKey(k), ipKey(k)] : [ipKey(k)];
			const rows = await this.db.$queryRawUnsafe<Array<{ scope: 'PAIR' | 'IP'; secs: number }>>(
				`SELECT "scope", CEIL(EXTRACT(EPOCH FROM ("blocked_until" - now())))::int AS secs FROM "login_guard_state" WHERE "key" = ANY($1::text[]) AND "blocked_until" > now() ORDER BY "blocked_until" DESC LIMIT 1`, keys);
			return rows[0] ? { blocked: true, scope: rows[0].scope, retryAfterSeconds: Math.max(1, Number(rows[0].secs)) } : { blocked: false };
		} catch (e) { if (!isMissingTableError(e)) logger.error(`[LoginGuard] check failed (open): ${(e as Error).message}`); return { blocked: false }; }
	}

	/** one atomic upsert per counter: a fresh window when the previous one expired, else fails + 1; the block starts the moment the threshold is reached */
	private async bump(key: string, scope: 'PAIR' | 'IP', ip: string, hint: string | null, max: number, c: LoginGuardConfig) {
		await this.db.$executeRawUnsafe(
			`INSERT INTO "login_guard_state" ("key","scope","ip","subject_hint","fails","window_start","last_fail_at","blocked_until")
			 VALUES ($1,$2,$3,$4,1,now(),now(), CASE WHEN $5::int <= 1 THEN now() + ($6::int * interval '1 minute') END)
			 ON CONFLICT ("key") DO UPDATE SET
			   "fails" = CASE WHEN "login_guard_state"."window_start" + ($7::int * interval '1 minute') <= now() AND ("login_guard_state"."blocked_until" IS NULL OR "login_guard_state"."blocked_until" <= now()) THEN 1 ELSE "login_guard_state"."fails" + 1 END,
			   "window_start" = CASE WHEN "login_guard_state"."window_start" + ($7::int * interval '1 minute') <= now() AND ("login_guard_state"."blocked_until" IS NULL OR "login_guard_state"."blocked_until" <= now()) THEN now() ELSE "login_guard_state"."window_start" END,
			   "last_fail_at" = now(),
			   "blocked_until" = CASE
			     WHEN "login_guard_state"."blocked_until" > now() THEN "login_guard_state"."blocked_until"
			     WHEN ((CASE WHEN "login_guard_state"."window_start" + ($7::int * interval '1 minute') <= now() THEN 1 ELSE "login_guard_state"."fails" + 1 END) >= $5::int) THEN now() + ($6::int * interval '1 minute')
			     ELSE NULL END`,
			key, scope, ip, hint, max, c.blockMin, c.windowMin);
	}

	async recordFailure(k: GuardKey): Promise<void> {
		try {
			const c = await this.config(); const ip = normalizeIp(k.ip);
			await this.bump(ipKey(k), 'IP', ip, null, c.ipMaxFails, c);
			if (k.email) await this.bump(pairKey(k), 'PAIR', ip, maskEmail(k.email.trim().toLowerCase()), c.maxFails, c);
		} catch (e) { if (!isMissingTableError(e)) logger.error(`[LoginGuard] record failed: ${(e as Error).message}`); }
	}

	/** a successful sign-in clears the address+account counter only (the address-wide counter keeps counting what it saw) */
	async recordSuccess(k: GuardKey): Promise<void> {
		if (!k.email) return;
		try { await this.db.$executeRawUnsafe(`DELETE FROM "login_guard_state" WHERE "key" = $1 AND ("blocked_until" IS NULL OR "blocked_until" <= now())`, pairKey(k)); } catch { /* fail open */ }
	}

	async listBlocks(limit = 100) {
		const rows = await this.db.$queryRawUnsafe<Array<{ key: string; scope: string; ip: string; subject_hint: string | null; fails: number; blocked_until: Date; last_fail_at: Date }>>(
			`SELECT "key","scope","ip","subject_hint","fails","blocked_until","last_fail_at" FROM "login_guard_state" WHERE "blocked_until" > now() ORDER BY "blocked_until" DESC LIMIT $1`, Math.min(Math.max(limit, 1), 500));
		return rows.map(r => ({ id: r.key, scope: r.scope, ip: r.ip, account: r.subject_hint, fails: Number(r.fails), blockedUntil: r.blocked_until, lastFailAt: r.last_fail_at }));
	}

	async unblock(id: string, actorUserId: string): Promise<boolean> {
		const n = await this.db.$executeRawUnsafe(`UPDATE "login_guard_state" SET "blocked_until" = NULL, "fails" = 0, "unblocked_by" = $2, "unblocked_at" = now() WHERE "key" = $1 AND "blocked_until" > now()`, id, actorUserId);
		return n > 0;
	}

	/** what a candidate set of limits would do to the counters and blocks that exist right now (shown before saving) */
	async impact(candidate: Partial<LoginGuardConfig>) {
		const cur = await this.config(); const c = { ...cur, ...candidate };
		const rows = await this.db.$queryRawUnsafe<Array<{ scope: string; blocked: number; would: number; total: number }>>(
			`SELECT "scope",
			   COUNT(*) FILTER (WHERE "blocked_until" > now())::int AS blocked,
			   COUNT(*) FILTER (WHERE ("blocked_until" IS NULL OR "blocked_until" <= now()) AND "window_start" + ($1::int * interval '1 minute') > now() AND "fails" >= (CASE WHEN "scope" = 'PAIR' THEN $2::int ELSE $3::int END))::int AS would,
			   COUNT(*)::int AS total FROM "login_guard_state" GROUP BY "scope"`, c.windowMin, c.maxFails, c.ipMaxFails);
		const by = (s: string) => rows.find(r => r.scope === s) ?? { blocked: 0, would: 0, total: 0 };
		return { current: cur, candidate: c, activeBlocks: { pair: Number(by('PAIR').blocked), ip: Number(by('IP').blocked) }, wouldBlockNextFailure: { pair: Number(by('PAIR').would), ip: Number(by('IP').would) },
			note: 'الحظر القائم يبقى حتى انتهاء مدته الأصلية؛ الحدود الجديدة تُطبَّق على المحاولات الفاشلة التالية فورًا.' };
	}
}
export const loginGuardService = new LoginGuardService();
