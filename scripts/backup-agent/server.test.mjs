import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import pg from "pg";
import { createBackupAgent, databaseEnv } from "./server.mjs";
const token = "isolated-agent-test-".repeat(3);
async function start(config, deps) {
  const agent = await createBackupAgent(config, deps);
  agent.server.listen(0, "127.0.0.1");
  await once(agent.server, "listening");
  const url = `http://127.0.0.1:${agent.server.address().port}`;
  const call = async (p, b, auth = token) => {
    const r = await fetch(url + p, {
      method: b ? "POST" : "GET",
      headers: {
        Authorization: `Bearer ${auth}`,
        "Content-Type": "application/json",
        connection: "close",
      },
      ...(b ? { body: JSON.stringify(b) } : {}),
    });
    return { status: r.status, data: await r.json() };
  };
  return { ...agent, call };
}
async function done(agent, id) {
  for (let n = 0; n < 200; n++) {
    const { data } = await agent.call(`/jobs/${id}`);
    if (!["QUEUED", "RUNNING"].includes(data.status)) return data;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw Error("timeout");
}
test("secrets are passed through environment, never process arguments", () => {
  const e = databaseEnv("postgresql://qa:p%40ss@localhost:5433/source");
  assert.equal(e.PGPASSWORD, "p@ss");
  assert.equal(e.PGDATABASE, "source");
});
test("persistent jobs: backup + checksum, idempotency, authorization, separate-target enforcement and restart", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-test-"));
  let runs = 0;
  const config = {
    directory: dir,
    token,
    sourceUrl: "postgresql://qa@localhost/source",
    recoveryUrl: "postgresql://qa@localhost/recovery",
  };
  const deps = {
    identity: async () => "same-cluster:same-database",
    run: async (_cmd, args) => {
      runs++;
      fs.writeFileSync(args[args.indexOf("--file") + 1], "isolated dump");
    },
  };
  let a = await start(config, deps);
  try {
    assert.equal((await a.call("/files", undefined, "wrong")).status, 401);
    const id = randomUUID();
    await a.call("/jobs", { id, action: "BACKUP" });
    const j = await done(a, id);
    assert.equal(j.status, "SUCCEEDED");
    assert.match(j.sha256, /^[0-9a-f]{64}$/);
    await a.call("/jobs", { id, action: "BACKUP" });
    assert.equal(runs, 1);
    assert.equal(
      (await a.call("/jobs", { id, action: "RESTORE", file: j.file })).status,
      409,
    );
    assert.equal(
      (
        await a.call("/jobs", {
          id: randomUUID(),
          action: "RESTORE",
          file: "../escape.dump",
        })
      ).status,
      400,
    );
    const restore = randomUUID();
    await a.call("/jobs", { id: restore, action: "RESTORE", file: j.file });
    const r = await done(a, restore);
    assert.equal(r.status, "FAILED");
    assert.match(r.message, /must differ/);
    assert.equal(runs, 1);
    await a.close();
    a = await start(config, deps);
    assert.equal((await a.call(`/jobs/${id}`)).data.status, "SUCCEEDED");
    assert.equal((await a.call("/files")).data.files.length, 1);
    assert.equal(runs, 1);
  } finally {
    await a.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
const url = process.env.QA_ISOLATED_PG_URL;
test(
  "PG: real pg_dump and pg_restore recover into a separate database and leave the source unchanged",
  {
    skip:
      !url || !/@127\.0\.0\.1:55432\/qa_/.test(url)
        ? "isolated PostgreSQL required"
        : false,
  },
  async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-pg-")),
      recovery = new URL(url);
    recovery.pathname = "/qa_recovery";
    const a = await start({
      directory: dir,
      token,
      sourceUrl: url,
      recoveryUrl: String(recovery),
      dumpBin: process.env.PG_DUMP_BIN,
      restoreBin: process.env.PG_RESTORE_BIN,
    });
    const source = new pg.Client({ connectionString: url }),
      target = new pg.Client({ connectionString: String(recovery) });
    await source.connect();
    await target.connect();
    try {
      await source.query("CREATE TABLE backup_agent_probe (value text)");
      await source.query(
        "INSERT INTO backup_agent_probe VALUES ('before backup')",
      );
      const id = randomUUID();
      await a.call("/jobs", { id, action: "BACKUP" });
      const j = await done(a, id);
      assert.equal(j.status, "SUCCEEDED", j.message);
      await source.query("UPDATE backup_agent_probe SET value='after backup'");
      const id2 = randomUUID();
      await a.call("/jobs", { id: id2, action: "RESTORE", file: j.file });
      const r = await done(a, id2);
      assert.equal(r.status, "SUCCEEDED", r.message);
      assert.equal(
        (await target.query("SELECT value FROM backup_agent_probe")).rows[0]
          .value,
        "before backup",
      );
      assert.equal(
        (await source.query("SELECT value FROM backup_agent_probe")).rows[0]
          .value,
        "after backup",
      );
    } finally {
      await a.close();
      await source.end();
      await target.end();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  },
);
