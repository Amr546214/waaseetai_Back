import { createHash } from "node:crypto";
import { z } from "zod";
import { prisma as defaultPrisma } from "../config/db";
import { AppError } from "../utils/app-error";

export const RESTORE_PHRASE = "أؤكد الاستعادة إلى قاعدة الاسترداد";
export const BACKUP_PHRASE = "إنشاء نسخة احتياطية";
export const PURGE_PHRASE = "أؤكد تنقية الكاش";
const uuid = z.string().uuid();
const failure = (message: string, status = 503) =>
  new AppError(message, status);
export class CloudflareAdapter {
  constructor(
    private request: typeof fetch = fetch,
    private env = process.env,
  ) {}
  private config() {
    if (
      this.env.CDN_PROVIDER !== "cloudflare" ||
      !this.env.CDN_API_TOKEN ||
      !/^[a-f0-9]{32}$/i.test(this.env.CDN_ZONE_ID || "")
    )
      throw failure(
        "يلزم CDN_PROVIDER=cloudflare وCDN_API_TOKEN وCDN_ZONE_ID صالح.",
      );
    return { zone: this.env.CDN_ZONE_ID!, token: this.env.CDN_API_TOKEN };
  }
  private async call(path: string, body?: unknown) {
    const c = this.config();
    try {
      const r = await this.request(
        `https://api.cloudflare.com/client/v4/${path.replace("{zone}", c.zone)}`,
        {
          method: body ? "POST" : "GET",
          headers: {
            Authorization: `Bearer ${c.token}`,
            "Content-Type": "application/json",
          },
          ...(body ? { body: JSON.stringify(body) } : {}),
          signal: AbortSignal.timeout(10000),
          redirect: "error",
        },
      );
      const data = (await r.json()) as any;
      if (!r.ok || data.success === false || data.errors?.length)
        throw failure(
          `رفض Cloudflare الطلب (${r.status}). تحقق من صلاحيات الرمز والخطة.`,
        );
      return data;
    } catch (e) {
      if (e instanceof AppError) throw e;
      throw failure("تعذر الحصول على نتيجة مؤكدة من Cloudflare.");
    }
  }
  async status() {
    const zone = (await this.call("zones/{zone}")).result;
    const until = new Date(
        Math.floor(Date.now() / 3600000) * 3600000,
      ).toISOString(),
      since = new Date(Date.parse(until) - 86400000).toISOString();
    let analytics: {
      requests: number;
      cachedRequests: number;
      bytes: number;
      cachedBytes: number;
    } | null = null;
    try {
      const c = this.config();
      const result = await this.call("graphql", {
        query: `query($zone: String!, $since: Time!, $until: Time!) { viewer { zones(filter: {zoneTag: $zone}) { httpRequests1hGroups(limit: 24, filter: {datetime_geq: $since, datetime_lt: $until}) { sum { requests cachedRequests bytes cachedBytes } } } } }`,
        variables: { zone: c.zone, since, until },
      });
      const rows = result.data?.viewer?.zones?.[0]?.httpRequests1hGroups;
      if (Array.isArray(rows))
        analytics = rows.reduce(
          (a, r) => {
            for (const key of Object.keys(a) as Array<keyof typeof a>)
              a[key] += Number(r.sum[key] || 0);
            return a;
          },
          { requests: 0, cachedRequests: 0, bytes: 0, cachedBytes: 0 },
        );
    } catch {
      /* Zone status remains useful when the token/plan lacks analytics access. */
    }
    return {
      name: String(zone.name),
      status: String(zone.status),
      since,
      until,
      analytics,
    };
  }
  async purge(files: string[]) {
    const hostname = new URL(this.env.FRONTEND_URL || "").hostname;
    for (const file of files) {
      let u: URL;
      try {
        u = new URL(file);
      } catch {
        throw failure("رابط كاش غير صالح.", 400);
      }
      if (
        u.protocol !== "https:" ||
        u.hostname !== hostname ||
        u.port ||
        u.username ||
        u.password ||
        u.hash
      )
        throw failure(
          "التنقية متاحة فقط لروابط HTTPS على مضيف هذه البيئة نفسه.",
          400,
        );
    }
    const r = await this.call("zones/{zone}/purge_cache", { files });
    return {
      accepted: true,
      providerId: typeof r.result?.id === "string" ? r.result.id : null,
      note: "قبل Cloudflare طلب تنقية الروابط. القبول لا يثبت أن كل رابط كان مخزنًا في الكاش.",
    };
  }
}

export class BackupAgentClient {
  constructor(
    private request: typeof fetch = fetch,
    private env = process.env,
  ) {}
  async call(path: string, body?: unknown): Promise<any> {
    const { BACKUP_AGENT_URL: base, BACKUP_AGENT_TOKEN: token } = this.env;
    if (!base || !token || token.length < 32)
      throw failure(
        "يلزم تشغيل عامل النسخ وضبط BACKUP_AGENT_URL وBACKUP_AGENT_TOKEN (32 حرفًا على الأقل).",
      );
    const url = new URL(base);
    if (
      !["http:", "https:"].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    )
      throw failure("عنوان عامل النسخ غير صالح.");
    try {
      const r = await this.request(`${base.replace(/\/$/, "")}${path}`, {
        method: body ? "POST" : "GET",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
        signal: AbortSignal.timeout(10000),
        redirect: "error",
      });
      if (!r.ok)
        throw failure(
          `عامل النسخ رفض الطلب (${r.status})؛ راجع إعداداته وسجله.`,
        );
      return await r.json();
    } catch (e) {
      if (e instanceof AppError) throw e;
      throw failure("تعذر تأكيد حالة عامل النسخ؛ أعد المحاولة بالمفتاح نفسه.");
    }
  }
}

/** Durable intent precedes external work. A purge with an uncertain answer is never silently repeated. Backup jobs are idempotent at the agent as well as here. */
export class InfrastructureActionsService {
  constructor(
    private db = defaultPrisma,
    readonly cdn = new CloudflareAdapter(),
    readonly backup = new BackupAgentClient(),
  ) {}
  private async intent(
    id: string,
    actor: string,
    action: string,
    payload: unknown,
    ip?: string,
  ) {
    if (!uuid.safeParse(id).success)
      throw failure("Idempotency-Key بصيغة UUID مطلوب.", 400);
    const fingerprint = createHash("sha256")
      .update(JSON.stringify({ actor, action, payload }))
      .digest("hex");
    return this.db.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`infra:${id}`}))`;
      const old = await tx.accountAuditLog.findUnique({ where: { id } });
      if (old) {
        if (
          (old.metaData as any)?.fingerprint !== fingerprint ||
          old.eventType !== action ||
          old.userId !== actor
        )
          throw failure("استُخدم مفتاح المحاولة لطلب آخر.", 409);
        return { fresh: false, result: old.afterData as any };
      }
      await tx.accountAuditLog.create({
        data: {
          id,
          userId: actor,
          category: "SYSTEM_AUDIT",
          title: "إجراء بنية تقنية",
          actionText: action,
          summary: "سُجّل قصد التنفيذ؛ النتيجة تُحدَّث من المزوّد",
          eventType: action,
          source: "ADMIN",
          actorLabel: "ADMIN",
          severity: "CRITICAL",
          status: "IN_REVIEW",
          ipAddress: ip?.slice(0, 80),
          metaData: { fingerprint, payload: payload as any },
        },
      });
      return { fresh: true, result: null };
    });
  }
  private async result(id: string, data: any, completed: boolean) {
    await this.db.accountAuditLog.update({
      where: { id },
      data: { afterData: data, status: ["FAILED", "INTERRUPTED"].includes(data.status) ? "REJECTED" : completed ? "COMPLETED" : "IN_REVIEW" },
    });
  }
  async purge(id: string, actor: string, body: unknown, ip?: string) {
    const b = z
      .object({
        files: z.array(z.string().max(2048)).min(1).max(30),
        reason: z.string().trim().min(10).max(1000),
        confirmation: z.literal(PURGE_PHRASE),
      })
      .strict()
      .safeParse(body);
    if (!b.success)
      throw failure(
        "يلزم 1–30 رابطًا وسبب من 10 أحرف وعبارة التأكيد الصحيحة.",
        400,
      );
    const intent = await this.intent(
      id,
      actor,
      "CDN_PURGE_REQUESTED",
      b.data,
      ip,
    );
    if (!intent.fresh) {
      if (intent.result) return intent.result;
      throw failure(
        "نتيجة الطلب السابق غير محسومة. تحقق من Cloudflare قبل إنشاء محاولة جديدة.",
        409,
      );
    }
    const result = await this.cdn.purge(b.data.files);
    await this.result(id, result, true);
    return result;
  }
  async submitBackup(id: string, actor: string, body: unknown, ip?: string) {
    const b = z
      .discriminatedUnion("action", [
        z
          .object({
            action: z.literal("BACKUP"),
            reason: z.string().trim().min(10).max(1000),
            confirmation: z.literal(BACKUP_PHRASE),
          })
          .strict(),
        z
          .object({
            action: z.literal("RESTORE"),
            file: z.string().regex(/^backup-[0-9a-f-]{36}\.dump$/),
            reason: z.string().trim().min(10).max(1000),
            confirmation: z.literal(RESTORE_PHRASE),
          })
          .strict(),
      ])
      .safeParse(body);
    if (!b.success)
      throw failure(
        "طلب النسخ أو الاسترداد غير صالح؛ راجع الملف والسبب وعبارة التأكيد.",
        400,
      );
    await this.intent(
      id,
      actor,
      `BACKUP_${b.data.action}_REQUESTED`,
      b.data,
      ip,
    );
    const result = await this.backup.call("/jobs", {
      id,
      action: b.data.action,
      ...("file" in b.data ? { file: b.data.file } : {}),
    });
    await this.result(
      id,
      result,
      ["SUCCEEDED", "FAILED", "INTERRUPTED"].includes(result.status),
    );
    return result;
  }
  async backupJob(id: string, actor: string) {
    if (!uuid.safeParse(id).success) throw failure("رقم مهمة غير صالح.", 400);
    const audit = await this.db.accountAuditLog.findUnique({ where: { id } });
    if (
      !audit ||
      !audit.eventType?.startsWith("BACKUP_") ||
      audit.userId !== actor
    )
      throw failure("المهمة غير موجودة.", 404);
    const job = await this.backup.call(`/jobs/${id}`);
    await this.result(
      id,
      job,
      ["SUCCEEDED", "FAILED", "INTERRUPTED"].includes(job.status),
    );
    return job;
  }
}
export const infrastructureActions = new InfrastructureActionsService();
