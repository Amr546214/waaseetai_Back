// Release invariant regression test: no automatic Prisma schema mutation on
// startup unless RUN_DB_MIGRATIONS/RUN_DB_PUSH are explicitly 'true'. Never
// invokes a real `prisma migrate deploy`/`db push` — a fake `npx` shim is
// placed first on PATH so every invocation is captured to a log file
// instead of actually running, and no DATABASE_URL is ever touched.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, chmodSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const REPO_ROOT = path.resolve(__dirname, '..');
const PRESTART_SCRIPT = path.join(REPO_ROOT, 'scripts', 'prestart.sh');
const ENTRYPOINT_SCRIPT = path.join(REPO_ROOT, 'scripts', 'docker-entrypoint.sh');
const PACKAGE_JSON = path.join(REPO_ROOT, 'package.json');

function runPrestartWithFakeNpx(env: Record<string, string>): string[] {
  const dir = mkdtempSync(path.join(tmpdir(), 'prestart-test-'));
  const logFile = path.join(dir, 'calls.log');
  const fakeNpx = path.join(dir, 'npx');
  writeFileSync(fakeNpx, `#!/usr/bin/env bash\necho "$@" >> "${logFile}"\nexit 0\n`);
  chmodSync(fakeNpx, 0o755);

  const baseEnv: Record<string, string | undefined> = { ...process.env };
  delete baseEnv.RUN_DB_MIGRATIONS;
  delete baseEnv.RUN_DB_PUSH;
  delete baseEnv.RUN_DB_PUSH_ACCEPT_DATA_LOSS;

  try {
    execFileSync('bash', [PRESTART_SCRIPT], {
      env: { ...baseEnv, ...env, PATH: `${dir}:${process.env.PATH}` } as NodeJS.ProcessEnv,
      stdio: 'pipe',
    });
  } finally {
    // Script always exits 0 via the fake npx (real prisma calls never run) —
    // nothing to special-case here.
  }

  let calls: string[] = [];
  try { calls = readFileSync(logFile, 'utf8').trim().split('\n').filter(Boolean); } catch { /* no calls logged */ }
  rmSync(dir, { recursive: true, force: true });
  return calls;
}

test('prestart.sh: RUN_DB_MIGRATIONS and RUN_DB_PUSH both explicitly false — never calls migrate deploy or db push', () => {
  const calls = runPrestartWithFakeNpx({ RUN_DB_MIGRATIONS: 'false', RUN_DB_PUSH: 'false' });
  assert.ok(calls.some(c => c.includes('prisma generate')), 'expected prisma generate to still run');
  assert.ok(!calls.some(c => c.includes('migrate deploy')), 'migrate deploy must NOT run when RUN_DB_MIGRATIONS=false');
  assert.ok(!calls.some(c => c.includes('db push')), 'db push must NOT run when RUN_DB_PUSH=false');
});

test('prestart.sh: both flags UNSET — defaults are fail-closed, never mutates schema', () => {
  const calls = runPrestartWithFakeNpx({});
  assert.ok(!calls.some(c => c.includes('migrate deploy')), 'migrate deploy must NOT run when RUN_DB_MIGRATIONS is unset');
  assert.ok(!calls.some(c => c.includes('db push')), 'db push must NOT run when RUN_DB_PUSH is unset');
});

test('prestart.sh: RUN_DB_MIGRATIONS=true calls migrate deploy, and never falls through to db push', () => {
  const calls = runPrestartWithFakeNpx({ RUN_DB_MIGRATIONS: 'true', RUN_DB_PUSH: 'true' });
  assert.ok(calls.some(c => c.includes('migrate deploy')), 'migrate deploy must run when RUN_DB_MIGRATIONS=true');
  assert.ok(!calls.some(c => c.includes('db push')), 'db push must not also run — migrate deploy takes precedence');
});

test('prestart.sh: RUN_DB_PUSH=true with RUN_DB_MIGRATIONS=false calls db push (not migrate deploy)', () => {
  const calls = runPrestartWithFakeNpx({ RUN_DB_MIGRATIONS: 'false', RUN_DB_PUSH: 'true' });
  assert.ok(calls.some(c => c.includes('db push')), 'db push must run when RUN_DB_PUSH=true and migrations is false');
  assert.ok(!calls.some(c => c.includes('migrate deploy')), 'migrate deploy must not run in this case');
});

test('package.json: prestart no longer runs an unconditional prisma migrate deploy', () => {
  const pkg = JSON.parse(readFileSync(PACKAGE_JSON, 'utf8'));
  const prestart = pkg.scripts?.prestart ?? '';
  assert.ok(!/prisma migrate deploy/.test(prestart), `prestart must not directly invoke migrate deploy unconditionally, got: ${prestart}`);
});

test('docker-entrypoint.sh: RUN_DB_MIGRATIONS and RUN_DB_PUSH both default to false in their fallback expressions', () => {
  const script = readFileSync(ENTRYPOINT_SCRIPT, 'utf8');
  assert.ok(script.includes('RUN_DB_MIGRATIONS:-false'), 'RUN_DB_MIGRATIONS must default to false');
  assert.ok(script.includes('RUN_DB_PUSH:-false'), 'RUN_DB_PUSH must default to false');
  assert.ok(!script.includes('RUN_DB_PUSH:-true'), 'RUN_DB_PUSH must not default to true anywhere in this script');
});
