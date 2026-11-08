#!/usr/bin/env node
/*
 * Writes the backup status file the application reads (contract: docs/backup-status-contract.md). NOT run by the application, NOT run by this repo's tests against any real path.
 * It never starts a backup or a restore: the backup job calls it AFTER it finished, passing only the outcome.
 *
 *   BACKUP_STATUS_FILE=/path/status.json node scripts/backup-status.cjs backup success <sizeBytes>
 *   BACKUP_STATUS_FILE=...               node scripts/backup-status.cjs backup failure <DUMP_FAILED|DISK_FULL|DB_UNREACHABLE|UPLOAD_FAILED|UNKNOWN>
 *   BACKUP_STATUS_FILE=...               node scripts/backup-status.cjs restore pass|fail <SCHEMA_OK|ROW_COUNTS_OK|CHECKSUM_OK|RESTORE_FAILED|COUNT_MISMATCH|UNKNOWN>
 * The file is replaced atomically (temp file in the same directory + rename), so a reader never sees a half-written file.
 */
const fs = require('node:fs');
const path = require('node:path');
const FAIL = ['DUMP_FAILED', 'DISK_FULL', 'DB_UNREACHABLE', 'UPLOAD_FAILED', 'UNKNOWN'];
const CHECK = ['SCHEMA_OK', 'ROW_COUNTS_OK', 'CHECKSUM_OK', 'RESTORE_FAILED', 'COUNT_MISMATCH', 'UNKNOWN'];

function record(file, kind, outcome, arg, now = new Date()) {
	let cur = { schemaVersion: 1 };
	try { const p = JSON.parse(fs.readFileSync(file, 'utf8')); if (p && p.schemaVersion === 1) cur = p; } catch { /* first run or unreadable: start clean */ }
	const at = now.toISOString();
	if (kind === 'backup' && outcome === 'success') {
		const size = Number(arg); if (!Number.isInteger(size) || size < 0) throw new Error('size must be a non-negative integer');
		Object.assign(cur, { lastAttemptAt: at, lastAttemptOutcome: 'success', lastSuccessAt: at, lastSuccessSizeBytes: size });
	} else if (kind === 'backup' && outcome === 'failure') {
		Object.assign(cur, { lastAttemptAt: at, lastAttemptOutcome: 'failure', lastFailureAt: at, lastFailureCode: FAIL.includes(arg) ? arg : 'UNKNOWN' });
	} else if (kind === 'restore' && (outcome === 'pass' || outcome === 'fail')) {
		Object.assign(cur, { lastRestoreTestAt: at, lastRestoreTestOutcome: outcome, lastRestoreTestCheck: CHECK.includes(arg) ? arg : 'UNKNOWN' });
	} else throw new Error('usage: backup success <bytes> | backup failure <CODE> | restore pass|fail <CHECK>');
	const tmp = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.tmp`);
	fs.writeFileSync(tmp, JSON.stringify(cur), { mode: 0o644 });
	fs.renameSync(tmp, file);
	return cur;
}
module.exports = { record };
if (require.main === module) {
	const file = process.env.BACKUP_STATUS_FILE;
	if (!file) { console.error('BACKUP_STATUS_FILE is not set'); process.exit(2); }
	try { record(file, process.argv[2], process.argv[3], process.argv[4]); } catch (e) { console.error(e.message); process.exit(2); }
}
