# Backup status contract

Today no backup job in this repository publishes its result (DEPLOYMENT.md describes a manual `pg_dump`). The admin monitoring pages therefore show «غير متاح» for backups until the job writes the file below.

**Producer (infra team):** the backup job, after every run, calls `scripts/backup-status.cjs` (it never starts a backup or restore; it only records an outcome and replaces the file atomically: temp file + rename).
**Consumer:** the backend reads the file, read-only, from the path in `BACKUP_STATUS_FILE` (never shown in any API/UI). The file must be readable by the API container (for example a mounted volume).

## File (JSON, at most 8 KB, `schemaVersion: 1`, unknown keys are rejected)
| field | type | meaning |
|---|---|---|
| schemaVersion | 1 | |
| lastAttemptAt / lastAttemptOutcome | ISO-8601 / `success` \| `failure` | the most recent run |
| lastSuccessAt, lastSuccessSizeBytes | ISO-8601, integer | last good backup |
| lastFailureAt, lastFailureCode | ISO-8601, `DUMP_FAILED` \| `DISK_FULL` \| `DB_UNREACHABLE` \| `UPLOAD_FAILED` \| `UNKNOWN` | coarse code only: no error text, paths or credentials |
| lastRestoreTestAt, lastRestoreTestOutcome, lastRestoreTestCheck | ISO-8601, `pass` \| `fail`, `SCHEMA_OK` \| `ROW_COUNTS_OK` \| `CHECKSUM_OK` \| `RESTORE_FAILED` \| `COUNT_MISMATCH` \| `UNKNOWN` | restore rehearsal on a scratch database |

Timestamps more than 5 minutes in the future make the file UNREADABLE.

## States the app reports (backup and restore-test separately)
`NO_DATA` (variable unset, file absent, or never written) · `OK` · `STALE` (last success older than `BACKUP_STALE_HOURS`, default 36; restore test `RESTORE_TEST_STALE_DAYS`, default 8) · `LAST_ATTEMPT_FAILED` (a newer failed attempt than the last success; for the restore test: the last result is `fail`) · `UNREADABLE` (corrupt, invalid, oversized, unreadable).

## Hooking the job (example, NOT executed anywhere by this change)
```
BACKUP_STATUS_FILE=/var/lib/waseet/backup-status.json
... run the dump ...
if [ $? -eq 0 ]; then node scripts/backup-status.cjs backup success "$(stat -c %s "$DUMP")"; else node scripts/backup-status.cjs backup failure DUMP_FAILED; fi
... after the scratch-database restore rehearsal: node scripts/backup-status.cjs restore pass SCHEMA_OK
```
Env read by the backend: `BACKUP_STATUS_FILE`, `BACKUP_STALE_HOURS`, `RESTORE_TEST_STALE_DAYS`.
