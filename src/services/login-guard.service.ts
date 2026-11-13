import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import { Prisma } from "@prisma/client";
import { prisma as defaultPrisma } from "../config/db";
import { logger } from "../config/logger";
import { systemSettingsService } from "./system-settings.service";
import { AppError } from "../utils/app-error";

export type LoginGuardConfig = {
  maxFails: number;
  windowMin: number;
  blockMin: number;
  ipMaxFails: number;
};
export type GuardKey = { ip: string; email?: string; recognised?: boolean };
export type BlockVerdict =
  | { blocked: false }
  | {
      blocked: true;
      scope: "PAIR" | "IP" | "ACCOUNT";
      retryAfterSeconds: number;
    };
export type Admission =
  | {
      blocked: true;
      scope: "PAIR" | "IP" | "ACCOUNT";
      retryAfterSeconds: number;
    }
  | { blocked: false; storage: boolean; lease?: string };
const policySchema = z
  .object({
    maxFails: z.number().int().min(3).max(50),
    windowMin: z.number().int().min(1).max(1440),
    blockMin: z.number().int().min(1).max(1440),
    ipMaxFails: z.number().int().min(5).max(500),
  })
  .refine(
    (v) => v.ipMaxFails >= v.maxFails,
    "حد عنوان IP يجب ألا يقل عن حد الحساب",
  );
export const validateLoginPolicy = (v: unknown): LoginGuardConfig => {
  const r = policySchema.safeParse(v);
  if (!r.success)
    throw new AppError(
      "حدود الدخول غير صالحة: حد IP لا يقل عن حد الحساب، والأعداد والفترات ضمن النطاق المسموح",
      400,
    );
  return r.data;
};
export const normalizeIp = (ip: string | undefined) => {
  const v = (ip || "").trim().toLowerCase();
  return v.startsWith("::ffff:") && v.includes(".") ? v.slice(7) : v;
};
export const maskEmail = (email: string) => {
  const [u, d] = email.split("@");
  return d ? `${u.slice(0, 1)}***@${d}` : "***";
};
const hash = (s: string) =>
  createHash("sha256").update(s).digest("hex").slice(0, 32);
const keysOf = (k: GuardKey) => ({
  ipKey: `i:${normalizeIp(k.ip)}`,
  pairKey: k.email
    ? `p:${normalizeIp(k.ip)}|${hash(k.email.trim().toLowerCase())}`
    : null,
  accountKey: k.email ? `a:${hash(k.email.trim().toLowerCase())}` : null,
});
type State = {
  key: string;
  scope: "PAIR" | "IP" | "ACCOUNT";
  fails: number;
  seconds: number;
};
type Lease = {
  id: string;
  ip_key: string;
  pair_key: string | null;
  account_key: string | null;
  ip: string;
  hint: string | null;
  policy: LoginGuardConfig;
};
let lastStorageWarning = 0;
const storageWarning = (e: unknown) => {
  if (Date.now() - lastStorageWarning > 60000) {
    lastStorageWarning = Date.now();
    logger.warn(
      `[LoginGuard] shared store unavailable; legacy login protection retained: ${(e as Error)?.message}`,
    );
  }
};
async function lock(tx: Prisma.TransactionClient, keys: Array<string | null>) {
  for (const key of [...new Set(keys.filter((v): v is string => !!v))].sort())
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`login:${key}`}))`;
}

/** Shared leases reserve concurrent capacity before a password check. Settlement and audit commit before the HTTP answer. */
export class LoginGuardService {
  constructor(private db: typeof defaultPrisma = defaultPrisma) {}
  async config(): Promise<LoginGuardConfig> {
    const g = (k: string) => systemSettingsService.get<number>(k);
    const [maxFails, windowMin, blockMin, ipMaxFails] = await Promise.all([
      g("loginMaxFailedAttempts"),
      g("loginAttemptWindowMinutes"),
      g("loginBlockMinutes"),
      g("loginIpMaxFailedAttempts"),
    ]);
    return validateLoginPolicy({ maxFails, windowMin, blockMin, ipMaxFails });
  }
  async reserve(k: GuardKey): Promise<Admission> {
    try {
      const c = await this.config(),
        keys = keysOf(k),
        ip = normalizeIp(k.ip),
        hint = k.email ? maskEmail(k.email) : null;
      return await this.db.$transaction(
        async (tx) => {
          await lock(tx, [keys.accountKey, keys.ipKey, keys.pairKey]);
          for (const [key, scope] of [
            [keys.ipKey, "IP"],
            [keys.pairKey, "PAIR"],
            [keys.accountKey, "ACCOUNT"],
          ] as const)
            if (key)
              await tx.$executeRaw`INSERT INTO login_guard_state(key,scope,ip,subject_hint,fails) VALUES(${key},${scope},${scope === "ACCOUNT" ? "" : ip},${hint},0) ON CONFLICT(key) DO NOTHING`;
          const all = [keys.ipKey, keys.pairKey, keys.accountKey].filter(
            Boolean,
          ) as string[];
          await tx.$executeRawUnsafe(
            `UPDATE login_guard_state SET fails=0,window_start=now(),blocked_until=NULL WHERE key=ANY($1::text[]) AND window_start+(CASE WHEN scope='ACCOUNT' THEN 1440 ELSE $2::int END)*interval '1 minute'<=now() AND (blocked_until IS NULL OR blocked_until<=now())`,
            all,
            c.windowMin,
          );
          const rows = await tx.$queryRawUnsafe<State[]>(
            `SELECT key,scope,fails,GREATEST(0,CEIL(EXTRACT(EPOCH FROM(blocked_until-now()))))::int AS seconds FROM login_guard_state WHERE key=ANY($1::text[])`,
            all,
          );
          const blocked = rows
            .filter(
              (r) => r.seconds > 0 && (r.scope !== "ACCOUNT" || !k.recognised),
            )
            .sort((a, b) => b.seconds - a.seconds)[0];
          if (blocked)
            return {
              blocked: true,
              scope: blocked.scope,
              retryAfterSeconds: blocked.seconds,
            };
          const active = await tx.$queryRawUnsafe<
            Array<{
              ip_key: string;
              pair_key: string | null;
              account_key: string | null;
            }>
          >(
            `SELECT ip_key,pair_key,account_key FROM login_guard_attempts WHERE expires_at>now() AND (ip_key=$1 OR pair_key=$2 OR account_key=$3)`,
            keys.ipKey,
            keys.pairKey,
            keys.accountKey,
          );
          for (const row of rows) {
            if (row.scope === "ACCOUNT" && k.recognised) continue;
            const n = active.filter((a) =>
              row.scope === "IP"
                ? a.ip_key === row.key
                : row.scope === "PAIR"
                  ? a.pair_key === row.key
                  : a.account_key === row.key,
            ).length;
            const limit = row.scope === "IP" ? c.ipMaxFails : c.maxFails;
            if (n >= Math.max(1, limit - row.fails))
              return { blocked: true, scope: row.scope, retryAfterSeconds: 1 };
          }
          const id = randomUUID();
          await tx.$executeRaw`INSERT INTO login_guard_attempts(id,ip_key,pair_key,account_key,ip,hint,policy) VALUES(${id},${keys.ipKey},${keys.pairKey},${keys.accountKey},${ip},${hint},${JSON.stringify(c)}::jsonb)`;
          return { blocked: false, storage: true, lease: id };
        },
        { timeout: 10000 },
      );
    } catch (e) {
      storageWarning(e);
      return { blocked: false, storage: false };
    }
  }
  async settle(id: string, status: number): Promise<void> {
    await this.db.$transaction(
      async (tx) => {
        const [pre] = await tx.$queryRawUnsafe<Lease[]>(
          `SELECT * FROM login_guard_attempts WHERE id=$1`,
          id,
        );
        if (!pre) return;
        await lock(tx, [pre.account_key, pre.ip_key, pre.pair_key]);
        const rows = await tx.$queryRawUnsafe<Lease[]>(
          `DELETE FROM login_guard_attempts WHERE id=$1 RETURNING *`,
          id,
        );
        const a = rows[0];
        if (!a) return;
        if (status === 401) {
          for (const [key, scope] of [
            [a.ip_key, "IP"],
            [a.pair_key, "PAIR"],
            [a.account_key, "ACCOUNT"],
          ] as const) {
            if (!key) continue;
            const max =
              scope === "IP" ? a.policy.ipMaxFails : a.policy.maxFails;
            // The all-address account layer remains a progressive delay, not a permanent account lock. Recognised origins skip it.
            const delay =
              scope === "ACCOUNT"
                ? `LEAST(900,30*power(2,LEAST(10,FLOOR(GREATEST(0,fails+1-$2::int)/3.0))::int))*interval '1 second'`
                : `$3::int*interval '1 minute'`;
            await tx.$executeRawUnsafe(
              `UPDATE login_guard_state SET fails=fails+1,last_fail_at=now(),blocked_until=CASE WHEN blocked_until>now() THEN blocked_until WHEN fails+1 >= $2::int THEN now()+${delay} ELSE NULL END WHERE key=$1`,
              key,
              max,
              ...(scope === "ACCOUNT" ? [] : [a.policy.blockMin]),
            );
          }
        } else if (status > 0 && status < 400) {
          if (a.pair_key)
            await tx.$executeRaw`UPDATE login_guard_state SET fails=0,blocked_until=NULL,window_start=now() WHERE key=${a.pair_key}`;
          if (a.account_key)
            await tx.$executeRaw`UPDATE login_guard_state SET fails=GREATEST(0,fails-1),blocked_until=NULL WHERE key=${a.account_key}`;
        }
      },
      { timeout: 10000 },
    );
  }
  async check(k: GuardKey): Promise<BlockVerdict> {
    try {
      const keys = keysOf(k);
      const rows = await this.db.$queryRawUnsafe<State[]>(
        `SELECT scope,CEIL(EXTRACT(EPOCH FROM(blocked_until-now())))::int AS seconds FROM login_guard_state WHERE key=ANY($1::text[]) AND blocked_until>now() ORDER BY blocked_until DESC LIMIT 1`,
        [
          keys.ipKey,
          keys.pairKey,
          ...(!k.recognised ? [keys.accountKey] : []),
        ].filter(Boolean),
      );
      return rows[0]
        ? {
            blocked: true,
            scope: rows[0].scope,
            retryAfterSeconds: Math.max(1, rows[0].seconds),
          }
        : { blocked: false };
    } catch (e) {
      storageWarning(e);
      return { blocked: false };
    }
  }
  // Compatibility for internal callers; the HTTP route always reserves before the credential check.
  async recordFailure(k: GuardKey) {
    const a = await this.reserve(k);
    if (!a.blocked && a.lease) await this.settle(a.lease, 401);
  }
  async recordSuccess(k: GuardKey) {
    const a = await this.reserve(k);
    if (!a.blocked && a.lease) await this.settle(a.lease, 200);
  }
  async listBlocks(limit = 100) {
    const rows = await this.db.$queryRawUnsafe<
      Array<{
        key: string;
        scope: string;
        ip: string;
        subject_hint: string | null;
        fails: number;
        blocked_until: Date;
        last_fail_at: Date;
      }>
    >(
      `SELECT key,scope,ip,subject_hint,fails,blocked_until,last_fail_at FROM login_guard_state WHERE blocked_until>now() ORDER BY blocked_until DESC LIMIT $1`,
      Math.min(Math.max(limit, 1), 500),
    );
    return rows.map((r) => ({
      id: r.key,
      scope: r.scope,
      ip: r.ip,
      account: r.subject_hint,
      fails: Number(r.fails),
      blockedUntil: r.blocked_until,
      lastFailAt: r.last_fail_at,
    }));
  }
  async unblock(
    id: string,
    actorUserId: string,
    actorIp?: string,
  ): Promise<boolean> {
    return this.db.$transaction(
      async (tx) => {
        const [target] = await tx.$queryRawUnsafe<
          Array<{ key: string; ip: string; scope: string }>
        >(`SELECT key,ip,scope FROM login_guard_state WHERE key=$1`, id);
        if (!target) return false;
        const pairs =
          target.scope === "IP"
            ? await tx.$queryRawUnsafe<Array<{ key: string }>>(
                `SELECT key FROM login_guard_state WHERE scope='PAIR' AND ip=$1`,
                target.ip,
              )
            : [{ key: id }];
        const accounts = pairs.map((p) =>
          p.key.startsWith("p:")
            ? `a:${p.key.split("|").pop()}`
            : p.key.startsWith("a:")
              ? p.key
              : null,
        );
        await lock(tx, [
          ...accounts,
          ...pairs.map((p) => p.key),
          id,
          target.ip ? `i:${target.ip}` : null,
        ]);
        const changed =
          await tx.$executeRaw`UPDATE login_guard_state SET blocked_until=NULL,fails=0,window_start=now(),unblocked_by=${actorUserId},unblocked_at=now() WHERE key=${id} AND blocked_until>now()`;
        if (!changed) return false;
        const reset = [
          ...accounts,
          ...(target.scope === "IP" ? pairs.map((p) => p.key) : []),
        ].filter(Boolean) as string[];
        if (reset.length)
          await tx.$executeRawUnsafe(
            `UPDATE login_guard_state SET blocked_until=NULL,fails=0,window_start=now() WHERE key=ANY($1::text[])`,
            reset,
          );
        await tx.$executeRawUnsafe(
          `DELETE FROM login_guard_attempts WHERE ${target.scope === "IP" ? "ip_key" : target.scope === "ACCOUNT" ? "account_key" : "pair_key"}=$1`,
          id,
        );
        await tx.accountAuditLog.create({
          data: {
            userId: actorUserId,
            category: "SYSTEM_AUDIT",
            title: "فك حظر دخول",
            actionText: "فك حظر مؤقت لمحاولات الدخول",
            summary: "فك حظر دخول مع إعادة ضبط التأخير المرتبط",
            eventType: "LOGIN_BLOCK_LIFTED",
            source: "ADMIN",
            severity: "WARNING",
            status: "COMPLETED",
            actorLabel: "ADMIN",
            ipAddress: actorIp?.slice(0, 80),
            metaData: {
              scope: target.scope,
              resetAccounts: accounts.filter(Boolean).length,
            },
          },
        });
        return true;
      },
      { timeout: 10000 },
    );
  }
  async impact(candidate: Partial<LoginGuardConfig>) {
    const current = await this.config();
    const clean = Object.fromEntries(
      Object.entries(candidate).filter(([, v]) => v !== undefined),
    );
    const c = validateLoginPolicy({ ...current, ...clean });
    const rows = await this.db.$queryRawUnsafe<
      Array<{ scope: string; blocked: number; would: number; total: number }>
    >(
      `SELECT scope,COUNT(*) FILTER(WHERE blocked_until>now())::int AS blocked,COUNT(*) FILTER(WHERE (blocked_until IS NULL OR blocked_until<=now()) AND window_start+(CASE WHEN scope='ACCOUNT' THEN 1440 ELSE $1::int END)*interval '1 minute'>now() AND fails+1 >= CASE WHEN scope='IP' THEN $3::int ELSE $2::int END)::int AS would,COUNT(*)::int AS total FROM login_guard_state GROUP BY scope`,
      c.windowMin,
      c.maxFails,
      c.ipMaxFails,
    );
    const by = (s: string) =>
      rows.find((r) => r.scope === s) ?? { blocked: 0, would: 0, total: 0 };
    return {
      current,
      candidate: c,
      activeBlocks: {
        pair: Number(by("PAIR").blocked),
        ip: Number(by("IP").blocked),
        account: Number(by("ACCOUNT").blocked),
      },
      wouldBlockNextFailure: {
        pair: Number(by("PAIR").would),
        ip: Number(by("IP").would),
      },
      note: "الحظر القائم يحتفظ بمدته. تنفذ الحدود الجديدة على المحاولات التالية، مع حجز سعة للطلبات المتزامنة وتأخير تصاعدي للحساب من الأجهزة غير المعروفة.",
    };
  }
  async cleanup() {
    try {
      await this.db
        .$executeRaw`DELETE FROM login_guard_attempts WHERE id IN(SELECT id FROM login_guard_attempts WHERE expires_at<now() LIMIT 500)`;
      const candidates = await this.db.$queryRawUnsafe<Array<{ key: string }>>(
        `SELECT key FROM login_guard_state WHERE last_fail_at<now()-interval '2 days' AND (blocked_until IS NULL OR blocked_until<now()) LIMIT 100`,
      );
      for (const { key } of candidates)
        await this.db.$transaction(async (tx) => {
          const [r] = await tx.$queryRawUnsafe<Array<{ ok: boolean }>>(
            `SELECT pg_try_advisory_xact_lock(hashtext($1)) AS ok`,
            `login:${key}`,
          );
          if (!r?.ok) return;
          await tx.$executeRaw`DELETE FROM login_guard_state WHERE key=${key} AND last_fail_at<now()-interval '2 days' AND (blocked_until IS NULL OR blocked_until<now()) AND NOT EXISTS(SELECT 1 FROM login_guard_attempts a WHERE a.expires_at>now() AND login_guard_state.key IN(a.ip_key,a.pair_key,a.account_key))`;
        });
    } catch (e) {
      storageWarning(e);
    }
  }
}
export const loginGuardService = new LoginGuardService();
