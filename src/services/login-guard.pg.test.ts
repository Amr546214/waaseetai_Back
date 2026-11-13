import { test, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import express from "express";
import http from "node:http";
import { once } from "node:events";
import { prisma } from "../config/db";
import { LoginGuardService } from "./login-guard.service";
import {
  systemSettingsService,
  SystemSettingsService,
} from "./system-settings.service";
import { loginGuardGate } from "../middlewares/login-guard.middleware";
import { loginLimiters } from "../middlewares/rate-limit.middleware";
import { PlatformSettingsService } from "./platform-settings.service";
const enabled =
  !!process.env.QA_ISOLATED_PG_URL &&
  process.env.QA_ISOLATED_PG_URL === process.env.DATABASE_URL &&
  /@(127\.0\.0\.1|localhost):55432\/qa_/.test(process.env.DATABASE_URL!);
const opts = {
  skip: enabled ? false : "isolated local QA PostgreSQL required",
};
after(async () => {
  await prisma.$disconnect();
});
async function reset(max = 3, ip = 20) {
  await prisma.$executeRawUnsafe(
    "TRUNCATE login_guard_attempts,login_guard_state",
  );
  for (const [key, value] of Object.entries({
    loginMaxFailedAttempts: max,
    loginIpMaxFailedAttempts: ip,
    loginAttemptWindowMinutes: 15,
    loginBlockMinutes: 10,
  }))
    await prisma.platformSetting.upsert({
      where: { key },
      create: { key, value, version: 1 },
      update: { value },
    });
  systemSettingsService.invalidate();
}
async function admin() {
  return prisma.user.create({
    data: {
      accountType: "SUPER_ADMIN",
      status: "ACTIVE",
      firstName: "Local",
      lastName: "QA",
      email: `guard-${randomUUID()}@example.test`,
    },
  });
}

test(
  "PG: 20 configured failures reach credential checking, the 21st is blocked; audited unblock immediately permits a correct password despite old limiters",
  opts,
  async () => {
    await reset(20, 100);
    process.env.RATE_LIMIT_ENABLED = "true";
    const guard = new LoginGuardService(prisma);
    const app = express();
    app.set("trust proxy", true);
    app.use(express.json());
    const limits = loginLimiters((r) => r.body.email);
    app.post(
      "/login",
      limits[0],
      loginGuardGate((r) => r.body.email, guard),
      ...limits.slice(1),
      (q, s) =>
        s
          .status(q.body.password === "right" ? 200 : 401)
          .json({ ok: q.body.password === "right" }),
    );
    app.use((e: any, _q: any, s: any, _n: any) =>
      s.status(e.statusCode || 500).json({ message: e.message }),
    );
    const server = http.createServer(app);
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const port = (server.address() as any).port;
    const call = async (password: string) => {
      const r = await fetch(`http://127.0.0.1:${port}/login`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-forwarded-for": "198.51.100.11",
          connection: "close",
        },
        body: JSON.stringify({ email: "guard@example.test", password }),
      });
      await r.text();
      return r.status;
    };
    try {
      for (let i = 0; i < 20; i++)
        assert.equal(await call("wrong"), 401, `failure ${i + 1}`);
      assert.equal(await call("wrong"), 429);
      const a = await admin();
      try {
        assert.equal(
          await guard.unblock(
            (await guard.listBlocks()).find((b) => b.scope === "PAIR")!.id,
            a.id,
            "127.0.0.1",
          ),
          true,
        );
        assert.equal(await call("right"), 200);
        assert.equal(
          await prisma.accountAuditLog.count({
            where: { userId: a.id, eventType: "LOGIN_BLOCK_LIFTED" },
          }),
          1,
        );
      } finally {
        await prisma.user.delete({ where: { id: a.id } });
      }
    } finally {
      server.closeAllConnections();
      await new Promise((r) => server.close(r));
    }
  },
);
test(
  "PG: two service instances share exactly three concurrent reservations; no fourth credential check enters before the failures commit",
  opts,
  async () => {
    await reset();
    const a = new LoginGuardService(prisma),
      b = new LoginGuardService(prisma),
      key = { ip: "198.51.100.12", email: "parallel@example.test" };
    const results = await Promise.all(
      Array.from({ length: 12 }, (_, i) => (i % 2 ? a : b).reserve(key)),
    );
    const admitted = results.filter((r) => !r.blocked);
    assert.equal(admitted.length, 3);
    assert.ok(admitted.every((r) => !r.blocked && r.storage));
    await Promise.all(admitted.map((r) => a.settle((r as any).lease, 401)));
    assert.equal((await b.reserve(key)).blocked, true);
    const rows = await prisma.$queryRawUnsafe<any[]>(
      "SELECT scope,fails FROM login_guard_state",
    );
    assert.ok(rows.every((r) => r.fails === 3));
  },
);
test(
  "PG: failures settle exactly once, abort frees capacity, expired leases recover, and a successful login clears the pair",
  opts,
  async () => {
    await reset();
    const g = new LoginGuardService(prisma),
      key = { ip: "198.51.100.13", email: "once@example.test" };
    const a: any = await g.reserve(key);
    await Promise.all([g.settle(a.lease, 401), g.settle(a.lease, 401)]);
    assert.ok(
      (
        await prisma.$queryRawUnsafe<any[]>(
          "SELECT fails FROM login_guard_state",
        )
      ).every((r) => r.fails === 1),
    );
    const abort: any = await g.reserve(key);
    await g.settle(abort.lease, 0);
    const expired: any = await g.reserve(key);
    await prisma.$executeRawUnsafe(
      "UPDATE login_guard_attempts SET expires_at=now()-interval '1 minute' WHERE id=$1",
      expired.lease,
    );
    await g.cleanup();
    assert.equal((await g.reserve(key)).blocked, false);
    await prisma.$executeRawUnsafe("DELETE FROM login_guard_attempts");
    const success: any = await g.reserve(key);
    await g.settle(success.lease, 200);
    assert.equal(
      (
        await prisma.$queryRawUnsafe<any[]>(
          "SELECT fails FROM login_guard_state WHERE scope='PAIR'",
        )
      )[0].fails,
      0,
    );
  },
);
test(
  "PG: failed audit rolls back unblock and reservation deletion; partial preview matches fails+1 boundary",
  opts,
  async () => {
    await reset();
    const g = new LoginGuardService(prisma),
      key = { ip: "198.51.100.14", email: "audit@example.test" };
    for (let i = 0; i < 3; i++) {
      const a: any = await g.reserve(key);
      await g.settle(a.lease, 401);
    }
    const failing = new LoginGuardService(
      new Proxy(prisma, {
        get(target, p) {
          if (p === "$transaction")
            return (fn: any) =>
              target.$transaction((tx) =>
                fn(
                  new Proxy(tx, {
                    get(t, q) {
                      if (q === "accountAuditLog")
                        return {
                          create: async () => {
                            throw Error("audit failed");
                          },
                        };
                      return Reflect.get(t, q);
                    },
                  }),
                ),
              );
          return Reflect.get(target, p);
        },
      }),
    );
    await assert.rejects(
      failing.unblock(
        (await g.listBlocks()).find((b) => b.scope === "PAIR")!.id,
        "invalid-admin",
      ),
      /audit failed/,
    );
    assert.equal((await g.check(key)).blocked, true);
    await reset();
    for (let i = 0; i < 2; i++) {
      const a: any = await g.reserve(key);
      await g.settle(a.lease, 401);
    }
    const impact = await g.impact({ windowMin: undefined });
    assert.equal(impact.candidate.windowMin, 15);
    assert.equal(impact.wouldBlockNextFailure.pair, 1);
    await assert.rejects(g.impact({ maxFails: 50, ipMaxFails: 5 }));
  },
);
test(
  "PG: shared public revision advances in the same transaction as settings and audit; failed audit changes nothing; retired writer cannot bypass it",
  opts,
  async () => {
    const a = await admin();
    const actor: any = {
      userId: a.id,
      isSuperAdmin: true,
      permissions: new Set(),
    };
    const s = new SystemSettingsService(prisma);
    try {
      const before = await s.publicSnapshot();
      const row = await prisma.platformSetting.findUnique({
        where: { key: "supportPhone" },
      });
      await s.update(actor, {
        changes: { supportPhone: "+20 1234567890" },
        expected: { supportPhone: row?.version ?? 0 },
      });
      const after = await s.publicSnapshot();
      assert.ok(after.revision > before.revision);
      assert.equal(after.data.supportPhone, "+20 1234567890");
      const failing = new SystemSettingsService(
        new Proxy(prisma, {
          get(target, p) {
            if (p === "$transaction")
              return (fn: any) =>
                target.$transaction((tx) =>
                  fn(
                    new Proxy(tx, {
                      get(t, q) {
                        if (q === "accountAuditLog")
                          return {
                            create: async () => {
                              throw Error("audit failed");
                            },
                          };
                        return Reflect.get(t, q);
                      },
                    }),
                  ),
                );
            return Reflect.get(target, p);
          },
        }),
      );
      const current = await prisma.platformSetting.findUniqueOrThrow({
        where: { key: "supportPhone" },
      });
      await assert.rejects(
        failing.update(actor, {
          changes: { supportPhone: "+20 9999999999" },
          expected: { supportPhone: current.version },
        }),
        /audit failed/,
      );
      s.invalidate();
      assert.equal((await s.publicSnapshot()).revision, after.revision);
      assert.equal(
        (await s.publicSnapshot()).data.supportPhone,
        "+20 1234567890",
      );
      await assert.rejects(
        new PlatformSettingsService().update(actor as any, {} as any),
        (e) => (e as any).statusCode === 410,
      );
    } finally {
      await prisma.user.delete({ where: { id: a.id } });
    }
  },
);
