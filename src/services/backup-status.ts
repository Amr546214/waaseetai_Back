import { open } from 'node:fs/promises';
import { z } from 'zod';

/**
 * Read-only reader of the status file the BACKUP JOB writes after every run (contract: docs/backup-status-contract.md).
 * The path comes from BACKUP_STATUS_FILE and is never returned. Size-bounded, time-limited, schema-validated; it never throws and never starts a backup or a restore.
 * Never exposes paths, hostnames, credentials or raw error text: only the coarse enumerated codes below.
 */
export const BACKUP_STATUS_MAX_BYTES = 8 * 1024;
export const DEFAULT_BACKUP_STALE_HOURS = 36;
export const DEFAULT_RESTORE_TEST_STALE_DAYS = 8;
const READ_TIMEOUT_MS = 2_000, FUTURE_SKEW_MS = 5 * 60_000;
export const BACKUP_FAILURE_CODES = ['DUMP_FAILED', 'DISK_FULL', 'DB_UNREACHABLE', 'UPLOAD_FAILED', 'UNKNOWN'] as const;
export const RESTORE_CHECK_CODES = ['SCHEMA_OK', 'ROW_COUNTS_OK', 'CHECKSUM_OK', 'RESTORE_FAILED', 'COUNT_MISMATCH', 'UNKNOWN'] as const;
export type BackupState = 'NO_DATA' | 'OK' | 'STALE' | 'LAST_ATTEMPT_FAILED' | 'UNREADABLE';

const iso = z.string().datetime({ offset: true });
const schema = z.object({
	schemaVersion: z.literal(1),
	lastAttemptAt: iso.optional(), lastAttemptOutcome: z.enum(['success', 'failure']).optional(),
	lastSuccessAt: iso.optional(), lastSuccessSizeBytes: z.number().int().nonnegative().max(2 ** 50).optional(),
	lastFailureAt: iso.optional(), lastFailureCode: z.enum(BACKUP_FAILURE_CODES).optional(),
	lastRestoreTestAt: iso.optional(), lastRestoreTestOutcome: z.enum(['pass', 'fail']).optional(), lastRestoreTestCheck: z.enum(RESTORE_CHECK_CODES).optional(),
}).strict();

export type Section = { state: BackupState; lastSuccessAt: string | null; attemptAt: string | null; attemptOutcome: string | null; failureCode?: string | null; check?: string | null; sizeBytes?: number | null; staleAfterHours: number };
export type BackupStatusReading = { readAt: string; backup: Section; restoreTest: Section };

const num = (v: string | undefined, d: number) => { const n = Number(v); return v && Number.isFinite(n) && n > 0 ? n : d; };
export function backupThresholds(env: NodeJS.ProcessEnv = process.env) {
	return { backupHours: num(env.BACKUP_STALE_HOURS, DEFAULT_BACKUP_STALE_HOURS), restoreHours: num(env.RESTORE_TEST_STALE_DAYS, DEFAULT_RESTORE_TEST_STALE_DAYS) * 24 };
}
const empty = (state: BackupState, staleAfterHours: number): Section => ({ state, lastSuccessAt: null, attemptAt: null, attemptOutcome: null, sizeBytes: null, failureCode: null, check: null, staleAfterHours });

async function readBounded(path: string): Promise<string> {
	const fh = await open(path, 'r');
	try {
		const buf = Buffer.alloc(BACKUP_STATUS_MAX_BYTES + 1);
		const { bytesRead } = await fh.read(buf, 0, buf.length, 0);
		if (bytesRead > BACKUP_STATUS_MAX_BYTES) throw new Error('too-large');
		return buf.subarray(0, bytesRead).toString('utf8');
	} finally { await fh.close(); }
}

export async function readBackupStatus(env: NodeJS.ProcessEnv = process.env, now = new Date()): Promise<BackupStatusReading> {
	const th = backupThresholds(env); const readAt = now.toISOString();
	const none = (state: BackupState): BackupStatusReading => ({ readAt, backup: empty(state, th.backupHours), restoreTest: empty(state, th.restoreHours) });
	const path = env.BACKUP_STATUS_FILE?.trim();
	if (!path) return none('NO_DATA');
	let raw: string;
	try { raw = await Promise.race([readBounded(path), new Promise<string>((_, rej) => { const t = setTimeout(() => rej(new Error('timeout')), READ_TIMEOUT_MS); t.unref?.(); })]); }
	catch (e) { return none((e as NodeJS.ErrnoException)?.code === 'ENOENT' ? 'NO_DATA' : 'UNREADABLE'); }
	let data: z.infer<typeof schema>;
	try { const p = schema.safeParse(JSON.parse(raw)); if (!p.success) return none('UNREADABLE'); data = p.data; } catch { return none('UNREADABLE'); }
	const t = now.getTime(); const ms = (v?: string) => (v ? Date.parse(v) : undefined);
	for (const v of [data.lastAttemptAt, data.lastSuccessAt, data.lastFailureAt, data.lastRestoreTestAt]) if (v && Date.parse(v) > t + FUTURE_SKEW_MS) return none('UNREADABLE'); // a clock that runs ahead is not a reading
	const s = ms(data.lastSuccessAt), a = ms(data.lastAttemptAt ?? data.lastFailureAt ?? data.lastSuccessAt);
	const hours = (x: number) => (t - x) / 3_600_000;
	let b: BackupState;
	if (s === undefined && a === undefined) b = 'NO_DATA';
	else if (data.lastAttemptOutcome === 'failure' && (s === undefined || (ms(data.lastAttemptAt) ?? 0) > s)) b = 'LAST_ATTEMPT_FAILED';
	else if (s === undefined) b = 'NO_DATA';
	else b = hours(s) > th.backupHours ? 'STALE' : 'OK';
	const backup: Section = { state: b, lastSuccessAt: data.lastSuccessAt ?? null, attemptAt: data.lastAttemptAt ?? null, attemptOutcome: data.lastAttemptOutcome ?? null, sizeBytes: data.lastSuccessSizeBytes ?? null, failureCode: b === 'LAST_ATTEMPT_FAILED' ? (data.lastFailureCode ?? 'UNKNOWN') : null, check: null, staleAfterHours: th.backupHours };
	const r = ms(data.lastRestoreTestAt);
	let rs: BackupState;
	if (r === undefined || !data.lastRestoreTestOutcome) rs = 'NO_DATA';
	else if (data.lastRestoreTestOutcome === 'fail') rs = 'LAST_ATTEMPT_FAILED';
	else rs = hours(r) > th.restoreHours ? 'STALE' : 'OK';
	const restoreTest: Section = { state: rs, lastSuccessAt: data.lastRestoreTestOutcome === 'pass' ? data.lastRestoreTestAt ?? null : null, attemptAt: data.lastRestoreTestAt ?? null, attemptOutcome: data.lastRestoreTestOutcome ?? null, check: data.lastRestoreTestCheck ?? null, staleAfterHours: th.restoreHours };
	return { readAt, backup, restoreTest };
}
