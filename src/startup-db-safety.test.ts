// Release invariant regression test: no automatic Prisma schema mutation on
// startup unless RUN_DB_MIGRATIONS/RUN_DB_PUSH are explicitly 'true'. Never
// invokes a real `prisma migrate deploy`/`db push` — a fake `npx` shim is
// placed first on PATH so every invocation is captured to a log file
// instead of actually running, and no DATABASE_URL is ever touched.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const REPO_ROOT = path.resolve(__dirname, '..');
const PRESTART_SCRIPT = path.join(REPO_ROOT, 'scripts', 'prestart.sh');
const ENTRYPOINT_SCRIPT = path.join(REPO_ROOT, 'scripts', 'docker-entrypoint.sh');
const PACKAGE_JSON = path.join(REPO_ROOT, 'package.json');

const bash = (process.platform === 'win32' ? [process.env.GIT_BASH_PATH, 'C:/Program Files/Git/bin/bash.exe', 'bash'] : ['bash'])
  .filter((candidate): candidate is string => !!candidate)
  .find(candidate => { try { execFileSync(candidate, ['-c', 'exit 0'], { stdio: 'ignore', timeout: 3000 }); return true; } catch { return false; } });
const hasBash = !!bash;
const shellPath = (value: string) => process.platform === 'win32' ? value.replace(/\\/g, '/').replace(/^([A-Za-z]):/, (_all, drive: string) => `/${drive.toLowerCase()}`) : value;

function runPrestartWithFakeNpx(env: Record<string, string>): string[] {
  const dir = mkdtempSync(path.join(tmpdir(), 'prestart-test-'));
  const logFile = path.join(dir, 'calls.log');
  const script = path.join(dir, 'prestart.sh');
  writeFileSync(script, readFileSync(PRESTART_SCRIPT, 'utf8').replace(/\r\n/g, '\n'));

  const baseEnv: Record<string, string | undefined> = { ...process.env };
  delete baseEnv.RUN_DB_MIGRATIONS;
  delete baseEnv.RUN_DB_PUSH;
  delete baseEnv.RUN_DB_PUSH_ACCEPT_DATA_LOSS;

  try {
    // Source in the SAME shell as the fake function. Empty PATH makes it
    // impossible for a real npx/Prisma executable to run, even on Windows.
    execFileSync(bash!, ['-c', 'npx() { printf "%s\\n" "$*" >> "$QA_CALL_LOG"; }; export PATH=""; source "$QA_PRESTART"'], {
      env: { ...baseEnv, ...env, QA_CALL_LOG: shellPath(logFile), QA_PRESTART: shellPath(script) } as NodeJS.ProcessEnv,
      stdio: 'pipe',
    });
    return readFileSync(logFile, 'utf8').trim().split(/\r?\n/).filter(Boolean);
  } finally {
    if (!path.resolve(dir).startsWith(path.resolve(tmpdir()) + path.sep)) throw new Error('unsafe test cleanup path');
    rmSync(dir, { recursive: true, force: true });
  }
}

test('prestart.sh: RUN_DB_MIGRATIONS and RUN_DB_PUSH both explicitly false — never calls migrate deploy or db push', { skip: !hasBash ? 'bash not installed on host' : false }, () => {
  const calls = runPrestartWithFakeNpx({ RUN_DB_MIGRATIONS: 'false', RUN_DB_PUSH: 'false' });
  assert.ok(calls.some(c => c.includes('prisma generate')), 'expected prisma generate to still run');
  assert.ok(!calls.some(c => c.includes('migrate deploy')), 'migrate deploy must NOT run when RUN_DB_MIGRATIONS=false');
  assert.ok(!calls.some(c => c.includes('db push')), 'db push must NOT run when RUN_DB_PUSH=false');
});

test('prestart.sh: both flags UNSET — defaults are fail-closed, never mutates schema', { skip: !hasBash ? 'bash not installed on host' : false }, () => {
  const calls = runPrestartWithFakeNpx({});
  assert.ok(!calls.some(c => c.includes('migrate deploy')), 'migrate deploy must NOT run when RUN_DB_MIGRATIONS is unset');
  assert.ok(!calls.some(c => c.includes('db push')), 'db push must NOT run when RUN_DB_PUSH is unset');
});

test('prestart.sh: RUN_DB_MIGRATIONS=true calls migrate deploy, and never falls through to db push', { skip: !hasBash ? 'bash not installed on host' : false }, () => {
  const calls = runPrestartWithFakeNpx({ RUN_DB_MIGRATIONS: 'true', RUN_DB_PUSH: 'true' });
  assert.ok(calls.some(c => c.includes('migrate deploy')), 'migrate deploy must run when RUN_DB_MIGRATIONS=true');
  assert.ok(!calls.some(c => c.includes('db push')), 'db push must not also run — migrate deploy takes precedence');
});

test('prestart.sh: RUN_DB_PUSH=true with RUN_DB_MIGRATIONS=false calls db push (not migrate deploy)', { skip: !hasBash ? 'bash not installed on host' : false }, () => {
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
