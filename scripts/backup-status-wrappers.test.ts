import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

/** The wrappers are run ONLY with harmless stand-in commands (true / false / a temp file) inside a temp directory. */
const dir = mkdtempSync(path.join(tmpdir(), 'qa-iso-mon-wrap-'));
after(() => rmSync(dir, { recursive: true, force: true }));
const B = path.join(__dirname, 'run-backup-with-status.sh'), R = path.join(__dirname, 'run-restore-test-with-status.sh');
const status = path.join(dir, 'status.json'), art = path.join(dir, 'artifact.dump');
const run = (script: string, args: string[], env: Record<string, string> = {}) => spawnSync('bash', [script, ...args], { env: { PATH: process.env.PATH!, ...env }, encoding: 'utf8' });
const read = () => JSON.parse(readFileSync(status, 'utf8'));
const ENV = { BACKUP_STATUS_FILE: status, BACKUP_ARTIFACT: art };

test('backup wrapper: success needs exit 0 AND a non-empty artifact; records its size; propagates the exit code', () => {
	writeFileSync(art, 'x'.repeat(1234));
	const r = run(B, ['--', 'true'], ENV); assert.equal(r.status, 0); assert.match(r.stdout, /success recorded/);
	const s = read(); assert.equal(s.lastAttemptOutcome, 'success'); assert.equal(s.lastSuccessSizeBytes, 1234); assert.ok(s.lastSuccessAt);
});

test('backup wrapper: non-zero exit, missing artifact and empty artifact are failures with a coarse code; a free-text code is reduced to UNKNOWN; the failing exit code is preserved', () => {
	let r = run(B, ['--', 'false'], ENV); assert.equal(r.status, 1); assert.match(r.stdout, /failure recorded/); let s = read(); assert.equal(s.lastAttemptOutcome, 'failure'); assert.equal(s.lastFailureCode, 'DUMP_FAILED'); assert.equal(s.lastSuccessSizeBytes, 1234, 'the last success is kept');
	rmSync(art); r = run(B, ['--', 'true'], ENV); assert.equal(r.status, 1, 'exit 0 without an artifact is not a success'); assert.equal(read().lastAttemptOutcome, 'failure');
	writeFileSync(art, ''); r = run(B, ['--', 'true'], ENV); assert.equal(r.status, 1); assert.equal(read().lastAttemptOutcome, 'failure');
	r = run(B, ['--', 'false'], { ...ENV, BACKUP_FAILURE_CODE: 'DISK_FULL' }); assert.equal(read().lastFailureCode, 'DISK_FULL');
	r = run(B, ['--', 'false'], { ...ENV, BACKUP_FAILURE_CODE: 'password=hunter2 /root/x' }); assert.equal(read().lastFailureCode, 'UNKNOWN');
	r = run(B, ['--', 'sh', '-c', 'exit 7'], ENV); assert.equal(r.status, 7);
});

test('restore wrapper: records pass/fail separately and never changes the backup fields; checks are enumerated', () => {
	writeFileSync(art, 'abc'); run(B, ['--', 'true'], ENV); const before = read();
	let r = run(R, ['--', 'true'], { BACKUP_STATUS_FILE: status, RESTORE_TEST_CHECK: 'ROW_COUNTS_OK' }); assert.equal(r.status, 0); assert.match(r.stdout, /pass recorded/);
	let s = read(); assert.equal(s.lastRestoreTestOutcome, 'pass'); assert.equal(s.lastRestoreTestCheck, 'ROW_COUNTS_OK');
	for (const k of ['lastAttemptAt', 'lastAttemptOutcome', 'lastSuccessAt', 'lastSuccessSizeBytes']) assert.equal(s[k], before[k], k);
	r = run(R, ['--', 'false'], { BACKUP_STATUS_FILE: status, RESTORE_TEST_FAIL_CHECK: 'COUNT_MISMATCH' }); assert.equal(r.status, 1); s = read(); assert.equal(s.lastRestoreTestOutcome, 'fail'); assert.equal(s.lastRestoreTestCheck, 'COUNT_MISMATCH'); assert.equal(s.lastSuccessAt, before.lastSuccessAt);
	run(R, ['--', 'true'], { BACKUP_STATUS_FILE: status, RESTORE_TEST_CHECK: 'free text /path' }); assert.equal(read().lastRestoreTestCheck, 'UNKNOWN');
	// and a backup run does not touch the restore fields
	const rt = read().lastRestoreTestAt; run(B, ['--', 'true'], ENV); assert.equal(read().lastRestoreTestAt, rt);
});

test('misuse runs NOTHING: no status file variable, no "--", no command; no temp file is left; output never contains paths or the command', async () => {
	const marker = path.join(dir, 'ran.marker');
	for (const [script, env, args] of [[B, {}, ['--', 'touch', marker]], [R, {}, ['--', 'touch', marker]], [B, ENV, ['touch', marker]], [R, ENV, ['touch', marker]], [B, ENV, ['--']], [R, ENV, []]] as const) {
		const r = run(script, [...args], env as any); assert.equal(r.status, 2); assert.equal(existsSync(marker), false, 'the command must not run on misuse');
	}
	const ok = run(B, ['--', 'true'], ENV); const out = ok.stdout + ok.stderr; for (const leak of [dir, 'artifact.dump', 'status.json', 'true']) assert.ok(!out.includes(leak), leak);
	assert.deepEqual(readdirSync(dir).filter(n => n.endsWith('.tmp')), []);
	// a status path that cannot be written is reported without a path
	const bad = run(B, ['--', 'true'], { BACKUP_STATUS_FILE: path.join(dir, 'no-such-dir', 's.json'), BACKUP_ARTIFACT: art }); assert.match(bad.stderr, /could not write/); assert.ok(!(bad.stdout + bad.stderr).includes('no-such-dir'));
});

test('the wrappers contain no backup/restore/pg_dump command of their own (they only wrap what they are given)', () => {
	for (const f of [B, R]) { const t = readFileSync(f, 'utf8').replace(/^#.*$/gm, ''); assert.ok(!/pg_dump|pg_restore|psql|createdb|dropdb|docker|ssh/.test(t), f); }
});
