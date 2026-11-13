import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { createHash, timingSafeEqual, randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import pg from "pg";

const ID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const FILE = /^backup-[0-9a-f-]{36}\.dump$/;
export function databaseEnv(connection) {
  const u = new URL(connection);
  if (
    !["postgres:", "postgresql:"].includes(u.protocol) ||
    !u.hostname ||
    u.pathname.length < 2
  )
    throw Error("Invalid database connection");
  return {
    PATH: process.env.PATH,
    LD_LIBRARY_PATH: process.env.LD_LIBRARY_PATH,
    PGHOST: u.hostname,
    PGPORT: u.port || "5432",
    PGDATABASE: decodeURIComponent(u.pathname.slice(1)),
    PGUSER: decodeURIComponent(u.username),
    PGPASSWORD: decodeURIComponent(u.password),
    PGSSLMODE: u.searchParams.get("sslmode") || "prefer",
    PGCONNECT_TIMEOUT: "10",
  };
}
async function identity(url) {
  const client = new pg.Client({
    connectionString: url,
    connectionTimeoutMillis: 10000,
  });
  try {
    await client.connect();
    const { rows } = await client.query(
      "SELECT system_identifier::text AS cluster, (SELECT oid::text FROM pg_database WHERE datname=current_database()) AS db FROM pg_control_system()",
    );
    return `${rows[0].cluster}:${rows[0].db}`;
  } finally {
    await client.end();
  }
}
function run(command, args, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      env,
      stdio: ["ignore", "ignore", "pipe"],
    });
    // Do not persist stderr: PostgreSQL errors can include connection strings or row data.
    child.stderr.resume();
    let killed = false;
    const timer = setTimeout(() => {
      killed = true;
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 5000).unref();
    }, 1800000);
    timer.unref();
    child.on("error", () => {
      clearTimeout(timer);
      reject(Error("PostgreSQL executable unavailable"));
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      code === 0
        ? resolve()
        : reject(
            Error(killed ? "Operation timed out" : "PostgreSQL command failed"),
          );
    });
  });
}
export async function createBackupAgent(config, dependencies = {}) {
  const { directory, token, sourceUrl, recoveryUrl } = config;
  if (
    !directory ||
    !path.isAbsolute(directory) ||
    !token ||
    token.length < 32 ||
    !sourceUrl
  )
    throw Error(
      "BACKUP_DIR (absolute), BACKUP_AGENT_TOKEN (32+ characters), SOURCE_DATABASE_URL required",
    );
  databaseEnv(sourceUrl);
  if (recoveryUrl) databaseEnv(recoveryUrl);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  if (fs.lstatSync(directory).isSymbolicLink())
    throw Error("Backup directory cannot be a symlink");
  const root = fs.realpathSync(directory),
    jobsDir = path.join(root, ".operations");
  fs.mkdirSync(jobsDir, { recursive: true, mode: 0o700 });
  if (fs.lstatSync(jobsDir).isSymbolicLink())
    throw Error("Operations directory cannot be a symlink");
  // Only one agent may own this directory. The OS supervisor removes a stale lock after checking that its former process exited.
  const lockPath = path.join(root, ".agent.lock"),
    lock = fs.openSync(lockPath, "wx", 0o600);
  fs.writeFileSync(lock, String(process.pid));
  const jobs = new Map();
  let running = false,
    stopping = false,
    closed = false;
  const persist = (job) => {
    const dest = path.join(jobsDir, `${job.id}.json`),
      temp = `${dest}.${randomUUID()}.tmp`;
    const fd = fs.openSync(temp, "wx", 0o600);
    try {
      fs.writeFileSync(fd, JSON.stringify(job));
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(temp, dest);
    const d = fs.openSync(jobsDir, "r");
    try {
      fs.fsyncSync(d);
    } finally {
      fs.closeSync(d);
    }
  };
  const digest = async (file) => {
    const hash = createHash("sha256");
    for await (const chunk of fs.createReadStream(file)) hash.update(chunk);
    return hash.digest("hex");
  };
  const safeFile = (name) => {
    if (!FILE.test(name)) throw Error("Invalid backup filename");
    const p = path.join(root, name),
      st = fs.lstatSync(p);
    if (!st.isFile() || st.isSymbolicLink() || fs.realpathSync(p) !== p)
      throw Error("Invalid backup file");
    return p;
  };
  for (const name of fs.readdirSync(jobsDir)) {
    if (!/^[0-9a-f-]{36}\.json$/i.test(name)) continue;
    const p = path.join(jobsDir, name);
    if (fs.lstatSync(p).isSymbolicLink()) throw Error("Invalid job manifest");
    const job = JSON.parse(fs.readFileSync(p, "utf8"));
    if (!ID.test(job.id) || name !== `${job.id}.json`)
      throw Error("Invalid job manifest");
    if (job.status === "RUNNING") {
      job.status = "INTERRUPTED";
      job.message =
        "Agent stopped during execution. Check the recovery database before creating a new job.";
      persist(job);
    }
    jobs.set(job.id, job);
  }
  const execute = dependencies.run || run,
    dbIdentity = dependencies.identity || identity;
  const publicJob = (j) => ({
    id: j.id,
    action: j.action,
    status: j.status,
    file: j.file || null,
    sha256: j.sha256 || null,
    createdAt: j.createdAt,
    finishedAt: j.finishedAt || null,
    message: j.message || "",
    target:
      j.action === "RESTORE" ? "separate-recovery-database" : "source-snapshot",
  });
  async function work() {
    if (running || stopping) return;
    const j = [...jobs.values()].find((j) => j.status === "QUEUED");
    if (!j) return;
    running = true;
    j.status = "RUNNING";
    persist(j);
    let temp;
    try {
      if (j.action === "BACKUP") {
        j.file = `backup-${j.id}.dump`;
        const file = path.join(root, j.file);
        temp = `${file}.tmp`;
        if (fs.existsSync(file) || fs.existsSync(temp))
          throw Error("Backup file already exists");
        fs.closeSync(fs.openSync(temp, "wx", 0o600));
        await execute(
          config.dumpBin || "pg_dump",
          ["--format=custom", "--no-owner", "--file", temp],
          databaseEnv(sourceUrl),
        );
        const fd = fs.openSync(temp, "r");
        try {
          fs.fsyncSync(fd);
        } finally {
          fs.closeSync(fd);
        }
        j.sha256 = await digest(temp);
        fs.renameSync(temp, file);
        temp = undefined;
        j.message =
          "Backup snapshot created; restoration is a separate operation.";
      } else {
        if (!recoveryUrl) throw Error("RESTORE_DATABASE_URL is not configured");
        const [source, target] = await Promise.all([
          dbIdentity(sourceUrl),
          dbIdentity(recoveryUrl),
        ]);
        if (source === target)
          throw Error("Recovery database must differ from the source database");
        const original = [...jobs.values()].find(
          (b) =>
            b.action === "BACKUP" &&
            b.status === "SUCCEEDED" &&
            b.file === j.file &&
            b.sha256,
        );
        const file = safeFile(j.file);
        if (!original || (await digest(file)) !== original.sha256)
          throw Error("Backup checksum or original manifest missing");
        await execute(
          config.restoreBin || "pg_restore",
          [
            "--clean",
            "--if-exists",
            "--no-owner",
            "--no-privileges",
            "--exit-on-error",
            "--single-transaction",
            "--dbname",
            databaseEnv(recoveryUrl).PGDATABASE,
            file,
          ],
          databaseEnv(recoveryUrl),
        );
        j.message =
          "Restored into the separate recovery database. The live database was not replaced.";
      }
      j.status = "SUCCEEDED";
    } catch (e) {
      j.status = "FAILED";
      j.message = e.message;
    } finally {
      if (temp)
        try {
          fs.unlinkSync(temp);
        } catch {}
      j.finishedAt = new Date().toISOString();
      persist(j);
      running = false;
      if (!stopping) setImmediate(work);
    }
  }
  const server = http.createServer(async (req, res) => {
    const reply = (status, body) => {
      res.writeHead(status, {
        "Content-Type": "application/json",
        "Cache-Control": "no-store",
      });
      res.end(JSON.stringify(body));
    };
    const supplied = Buffer.from(req.headers.authorization || ""),
      expected = Buffer.from(`Bearer ${token}`);
    if (
      supplied.length !== expected.length ||
      !timingSafeEqual(supplied, expected)
    )
      return reply(401, { error: "Unauthorized" });
    try {
      if (req.method === "GET" && req.url === "/files") {
        const files = [...jobs.values()]
          .filter((j) => j.action === "BACKUP" && j.status === "SUCCEEDED")
          .flatMap((j) => {
            try {
              const st = fs.statSync(safeFile(j.file));
              return [
                {
                  file: j.file,
                  bytes: st.size,
                  at: j.finishedAt,
                  sha256: j.sha256,
                },
              ];
            } catch {
              return [];
            }
          })
          .sort((a, b) => b.at.localeCompare(a.at))
          .slice(0, 100);
        return reply(200, {
          files,
          recoveryConfigured: !!recoveryUrl,
          target: "separate-recovery-database",
        });
      }
      if (req.method === "GET" && req.url?.startsWith("/jobs/")) {
        const j = jobs.get(req.url.slice(6));
        return j
          ? reply(200, publicJob(j))
          : reply(404, { error: "Not found" });
      }
      if (req.method !== "POST" || req.url !== "/jobs")
        return reply(404, { error: "Not found" });
      let raw = "";
      for await (const chunk of req) {
        raw += chunk;
        if (Buffer.byteLength(raw) > 4096)
          return reply(413, { error: "Request too large" });
      }
      const b = JSON.parse(raw);
      if (
        !ID.test(b.id) ||
        !["BACKUP", "RESTORE"].includes(b.action) ||
        (b.action === "RESTORE" && !FILE.test(b.file || "")) ||
        Object.keys(b).some((k) => !["id", "action", "file"].includes(k))
      )
        return reply(400, { error: "Invalid job" });
      if (b.action === "RESTORE" && !recoveryUrl)
        return reply(503, { error: "Recovery target not configured" });
      const old = jobs.get(b.id);
      if (old)
        return old.action === b.action &&
          (old.action === "BACKUP" || old.file === b.file)
          ? reply(200, publicJob(old))
          : reply(409, { error: "Idempotency conflict" });
      if (
        [...jobs.values()].filter((j) =>
          ["QUEUED", "RUNNING"].includes(j.status),
        ).length >= 5
      )
        return reply(429, { error: "Queue full" });
      const j = {
        id: b.id,
        action: b.action,
        ...(b.action === "RESTORE" ? { file: b.file } : {}),
        status: "QUEUED",
        createdAt: new Date().toISOString(),
      };
      persist(j);
      jobs.set(j.id, j);
      reply(202, publicJob(j));
      setImmediate(work);
    } catch {
      reply(400, { error: "Invalid request or inaccessible backup" });
    }
  });
  setImmediate(work);
  return {
    server,
    async close() {
      if (closed) return;
      closed = true;
      stopping = true;
      if (server.listening) await new Promise((r) => server.close(r));
      while (running) await new Promise((r) => setTimeout(r, 25));
      fs.closeSync(lock);
      fs.unlinkSync(lockPath);
    },
  };
}
if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const agent = await createBackupAgent({
    directory: process.env.BACKUP_DIR,
    token: process.env.BACKUP_AGENT_TOKEN,
    sourceUrl: process.env.SOURCE_DATABASE_URL,
    recoveryUrl: process.env.RESTORE_DATABASE_URL,
    dumpBin: process.env.PG_DUMP_BIN,
    restoreBin: process.env.PG_RESTORE_BIN,
  });
  agent.server.listen(
    Number(process.env.BACKUP_AGENT_PORT || 5098),
    process.env.BACKUP_AGENT_HOST || "127.0.0.1",
  );
  for (const signal of ["SIGTERM", "SIGINT"])
    process.on(signal, () => void agent.close().then(() => process.exit(0)));
}
