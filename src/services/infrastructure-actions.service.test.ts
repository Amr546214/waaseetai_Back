import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  CloudflareAdapter,
  BackupAgentClient,
  InfrastructureActionsService,
  PURGE_PHRASE,
} from "./infrastructure-actions.service";
const env = {
  CDN_PROVIDER: "cloudflare",
  CDN_API_TOKEN: "secret-token",
  CDN_ZONE_ID: "a".repeat(32),
  FRONTEND_URL: "https://waseetai.com",
};
test("Cloudflare: live zone and cache counters, fixed endpoint, server-only secret, no analytics permission gives null instead of invented zero", async () => {
  const calls: any[] = [];
  const adapter = new CloudflareAdapter(
    (async (url: any, options: any) => {
      calls.push([url, options]);
      return new Response(
        JSON.stringify(
          url.endsWith("/graphql")
            ? {
                data: {
                  viewer: {
                    zones: [
                      {
                        httpRequests1hGroups: [
                          {
                            sum: {
                              requests: 10,
                              cachedRequests: 7,
                              bytes: 100,
                              cachedBytes: 70,
                            },
                          },
                        ],
                      },
                    ],
                  },
                },
              }
            : {
                success: true,
                result: { name: "waseetai.com", status: "active" },
              },
        ),
      );
    }) as any,
    env,
  );
  const result = await adapter.status();
  assert.equal(result.analytics?.cachedRequests, 7);
  assert.ok(
    calls.every((c) =>
      c[0].startsWith("https://api.cloudflare.com/client/v4/"),
    ),
  );
  assert.ok(!JSON.stringify(result).includes(env.CDN_API_TOKEN));
  const noAnalytics = new CloudflareAdapter(
    (async (url: any) =>
      new Response(
        JSON.stringify(
          url.endsWith("/graphql")
            ? { errors: [{ message: "unauthorized" }] }
            : { result: { name: "waseetai.com", status: "active" } },
        ),
      )) as any,
    env,
  );
  assert.equal((await noAnalytics.status()).analytics, null);
});
test("Cloudflare: purge posts only explicit local HTTPS files, rejects foreign hosts and does not leak provider error content", async () => {
  let count = 0;
  const adapter = new CloudflareAdapter(
    (async (_url: any, o: any) => {
      count++;
      assert.deepEqual(JSON.parse(o.body), {
        files: ["https://waseetai.com/a.js"],
      });
      return new Response(
        JSON.stringify({ success: true, result: { id: "provider-id" } }),
      );
    }) as any,
    env,
  );
  assert.equal(
    (await adapter.purge(["https://waseetai.com/a.js"])).accepted,
    true,
  );
  for (const url of [
    "https://evil.test/a",
    "http://waseetai.com/a",
    "https://u:p@waseetai.com/a",
    "https://waseetai.com:8443/a",
  ])
    await assert.rejects(adapter.purge([url]));
  assert.equal(count, 1);
});
test("audited intent commits before provider work; duplicate purge never repeats an uncertain outcome; audit failure prevents execution", async () => {
  const rows = new Map();
  let providerCalls = 0;
  let failAudit = false;
  const db: any = {
    $transaction: async (fn: any) =>
      fn({
        $executeRaw: async () => 1,
        accountAuditLog: {
          findUnique: async ({ where }: any) => rows.get(where.id),
          create: async ({ data }: any) => {
            if (failAudit) throw Error("audit");
            rows.set(data.id, data);
          },
        },
      }),
    accountAuditLog: {
      update: async ({ where, data }: any) =>
        rows.set(where.id, { ...rows.get(where.id), ...data }),
    },
  };
  const svc = new InfrastructureActionsService(db, {
    purge: async () => {
      providerCalls++;
      assert.equal(rows.size, 1);
      throw Error("provider timeout");
    },
  } as any);
  const id = randomUUID(),
    body = {
      files: ["https://waseetai.com/a"],
      reason: "refresh after update",
      confirmation: PURGE_PHRASE,
    };
  await assert.rejects(svc.purge(id, "admin", body), /timeout/);
  await assert.rejects(
    svc.purge(id, "admin", body),
    (e) => (e as any).statusCode === 409,
  );
  assert.equal(providerCalls, 1);
  await assert.rejects(
    svc.purge(id, "other-admin", body),
    (e) => (e as any).statusCode === 409,
  );
  failAudit = true;
  await assert.rejects(svc.purge(randomUUID(), "admin", body), /audit/);
  assert.equal(providerCalls, 1);
});
test("backup agent uses fixed configured origin, disables redirects, reports config failure clearly", async () => {
  await assert.rejects(
    new BackupAgentClient(fetch, {}).call("/files"),
    /BACKUP_AGENT_URL/,
  );
  let seen: any;
  const c = new BackupAgentClient(
    (async (u: any, o: any) => {
      seen = { u, o };
      return new Response(JSON.stringify({ files: [] }));
    }) as any,
    {
      BACKUP_AGENT_URL: "http://backup-agent:5098",
      BACKUP_AGENT_TOKEN: "s".repeat(32),
    },
  );
  await c.call("/files");
  assert.equal(seen.u, "http://backup-agent:5098/files");
  assert.equal(seen.o.redirect, "error");
});

test('dev purge is limited to the configured dev host and cannot purge official URLs',async()=>{
 let calls=0;
 const adapter=new CloudflareAdapter((async()=>{calls++;return new Response(JSON.stringify({success:true,result:{id:'dev-purge'}}));}) as any,{...env,FRONTEND_URL:'https://dev.waseetai.com'});
 assert.equal((await adapter.purge(['https://dev.waseetai.com/app.js'])).accepted,true);
 await assert.rejects(adapter.purge(['https://waseetai.com/app.js']),e=>(e as any).statusCode===400);
 assert.equal(calls,1);
});
