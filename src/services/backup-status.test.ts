import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { readBackupStatus, BACKUP_STATUS_MAX_BYTES } from './backup-status';

const dir = mkdtempSync(path.join(tmpdir(), 'qa-iso-mon-bk-'));
const file = path.join(dir, 'status.json'); const env = (extra: any = {}) => ({ BACKUP_STATUS_FILE: file, ...extra }) as NodeJS.ProcessEnv;
const now = new Date('2026-11-09T12:00:00Z'); const ago = (h: number) => new Date(now.getTime() - h * 3_600_000).toISOString();
const put = (o: unknown) => writeFileSync(file, typeof o === 'string' ? o : JSON.stringify(o));
const base = { schemaVersion: 1 };

test('NO_DATA: variable unset, file absent, or an empty record', async () => {
	assert.equal((await readBackupStatus({}, now)).backup.state, 'NO_DATA');
	assert.equal((await readBackupStatus(env({ BACKUP_STATUS_FILE: path.join(dir, 'missing.json') }), now)).restoreTest.state, 'NO_DATA');
	put(base); const r = await readBackupStatus(env(), now); assert.equal(r.backup.state, 'NO_DATA'); assert.equal(r.restoreTest.state, 'NO_DATA');
});

test('OK / STALE / LAST_ATTEMPT_FAILED for the backup, separately from the restore test; thresholds are env-overridable', async () => {
	put({ ...base, lastAttemptAt: ago(2), lastAttemptOutcome: 'success', lastSuccessAt: ago(2), lastSuccessSizeBytes: 5_000_000, lastRestoreTestAt: ago(24), lastRestoreTestOutcome: 'pass', lastRestoreTestCheck: 'SCHEMA_OK' });
	let r = await readBackupStatus(env(), now); assert.equal(r.backup.state, 'OK'); assert.equal(r.backup.sizeBytes, 5_000_000); assert.equal(r.restoreTest.state, 'OK'); assert.equal(r.restoreTest.check, 'SCHEMA_OK'); assert.equal(r.readAt, now.toISOString());
	put({ ...base, lastAttemptAt: ago(40), lastAttemptOutcome: 'success', lastSuccessAt: ago(40), lastRestoreTestAt: ago(9 * 24), lastRestoreTestOutcome: 'pass' });
	r = await readBackupStatus(env(), now); assert.equal(r.backup.state, 'STALE'); assert.equal(r.backup.staleAfterHours, 36); assert.equal(r.restoreTest.state, 'STALE');
	assert.equal((await readBackupStatus(env({ BACKUP_STALE_HOURS: '48', RESTORE_TEST_STALE_DAYS: '10' }), now)).backup.state, 'OK');
	assert.equal((await readBackupStatus(env({ BACKUP_STALE_HOURS: '48', RESTORE_TEST_STALE_DAYS: '10' }), now)).restoreTest.state, 'OK');
	assert.equal((await readBackupStatus(env({ BACKUP_STALE_HOURS: 'abc' }), now)).backup.staleAfterHours, 36);
	put({ ...base, lastAttemptAt: ago(1), lastAttemptOutcome: 'failure', lastFailureAt: ago(1), lastFailureCode: 'DISK_FULL', lastSuccessAt: ago(20), lastSuccessSizeBytes: 1, lastRestoreTestAt: ago(5), lastRestoreTestOutcome: 'fail', lastRestoreTestCheck: 'COUNT_MISMATCH' });
	r = await readBackupStatus(env(), now); assert.equal(r.backup.state, 'LAST_ATTEMPT_FAILED'); assert.equal(r.backup.failureCode, 'DISK_FULL'); assert.equal(r.restoreTest.state, 'LAST_ATTEMPT_FAILED'); assert.equal(r.restoreTest.check, 'COUNT_MISMATCH');
	// an OLDER failure than the last success does not make the current state failed
	put({ ...base, lastAttemptAt: ago(1), lastAttemptOutcome: 'success', lastSuccessAt: ago(1), lastFailureAt: ago(30), lastFailureCode: 'UNKNOWN' });
	assert.equal((await readBackupStatus(env(), now)).backup.state, 'OK');
	// a failure with no success at all
	put({ ...base, lastAttemptAt: ago(1), lastAttemptOutcome: 'failure', lastFailureAt: ago(1), lastFailureCode: 'DUMP_FAILED' });
	r = await readBackupStatus(env(), now); assert.equal(r.backup.state, 'LAST_ATTEMPT_FAILED'); assert.equal(r.backup.lastSuccessAt, null);
});

test('UNREADABLE: corrupt, wrong schema, unknown keys, bad enum, oversized, future timestamps, a directory', async () => {
	for (const bad of ['{not json', '[]', '{"schemaVersion":2}', JSON.stringify({ ...base, extra: 1 }), JSON.stringify({ ...base, lastFailureCode: 'disk /var/lib/secret full' }), JSON.stringify({ ...base, lastSuccessAt: 'yesterday' }), JSON.stringify({ ...base, lastSuccessSizeBytes: -1 }),
		JSON.stringify({ ...base, lastSuccessAt: new Date(now.getTime() + 3_600_000).toISOString() }), JSON.stringify({ ...base, lastRestoreTestAt: new Date(now.getTime() + 86_400_000).toISOString(), lastRestoreTestOutcome: 'pass' })]) {
		put(bad); const r = await readBackupStatus(env(), now); assert.equal(r.backup.state, 'UNREADABLE', bad); assert.equal(r.restoreTest.state, 'UNREADABLE');
	}
	put(JSON.stringify({ ...base, pad: 'x'.repeat(BACKUP_STATUS_MAX_BYTES) })); assert.equal((await readBackupStatus(env(), now)).backup.state, 'UNREADABLE');
	assert.equal((await readBackupStatus(env({ BACKUP_STATUS_FILE: dir }), now)).backup.state, 'UNREADABLE');
	// a small clock skew (< 5 min ahead) is tolerated
	put({ ...base, lastAttemptAt: new Date(now.getTime() + 60_000).toISOString(), lastAttemptOutcome: 'success', lastSuccessAt: new Date(now.getTime() + 60_000).toISOString() });
	assert.equal((await readBackupStatus(env(), now)).backup.state, 'OK');
});

test('the result never contains the path, the directory, a host name or raw text', async () => {
	put({ ...base, lastAttemptAt: ago(1), lastAttemptOutcome: 'failure', lastFailureAt: ago(1), lastFailureCode: 'UPLOAD_FAILED' });
	const text = JSON.stringify(await readBackupStatus(env(), now));
	for (const leak of [file, dir, 'qa-iso-mon-bk', 'status.json']) assert.ok(!text.includes(leak), leak);
	put('{bad'); assert.ok(!JSON.stringify(await readBackupStatus(env(), now)).includes(dir));
});

test('the writer script replaces the file atomically (temp + rename), keeps both sections, validates input, and the reader accepts its output; nothing else runs', async () => {
	const { record } = createRequire(import.meta.url)('../../scripts/backup-status.cjs');
	const f = path.join(dir, 'written.json');
	record(f, 'backup', 'failure', 'secret /path/with/text', new Date(now.getTime() - 7_200_000)); // free text is reduced to UNKNOWN
	assert.equal(JSON.parse(readFileSync(f, 'utf8')).lastFailureCode, 'UNKNOWN');
	record(f, 'backup', 'success', '12345', new Date(now.getTime() - 3_600_000));
	record(f, 'restore', 'pass', 'ROW_COUNTS_OK', new Date(now.getTime() - 1_800_000));
	assert.deepEqual(readdirSync(dir).filter(n => n.endsWith('.tmp')), [], 'no temp file is left behind');
	const r = await readBackupStatus({ BACKUP_STATUS_FILE: f } as any, now);
	assert.equal(r.backup.state, 'OK'); assert.equal(r.backup.sizeBytes, 12345); assert.equal(r.restoreTest.state, 'OK'); assert.equal(r.restoreTest.check, 'ROW_COUNTS_OK');
	assert.throws(() => record(f, 'backup', 'success', '-5'), /size/); assert.throws(() => record(f, 'restore', 'maybe', 'X'), /usage/); assert.throws(() => record(f, 'drop', 'x', 'y'), /usage/);
});

test.after(() => rmSync(dir, { recursive: true, force: true }));
