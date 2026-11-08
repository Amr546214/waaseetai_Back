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

## Where the backup job lives (findings, 2026-11-09, from local/offline evidence only)
- **Not in the backend or frontend repository.** No script, compose service, Jenkinsfile, cron or systemd file runs a backup. `DEPLOYMENT.md` only documents a manual `pg_dump` command; `git log` has no commit that introduces or maintains a backup job (the only "restore" commits are site-identity version restore, unrelated).
- **Found only in ops notes:** `ops/DISK-CLEANUP-PROPOSAL-20261019.md` says dumps live under `/root/backups` on the server and must not be deleted; the local `ops/backups-local/` holds `dev-pre-*` and `waseetai-dev-db-*.dump` snapshots taken before changes. No schedule, script or owner is named anywhere. So the job (if scheduled at all) lives on the server or in an external scheduler.
- **Owner:** by role, whoever has server access and owns the backup schedule (the same person/team that runs the dev deploy scripts). No individual is named because nothing in git or the notes shows who runs it; git authorship of the monitoring commits is not evidence of ownership.

## HANDOFF: wiring the job to the panel (NOT applied by this change)
Ready-made wrappers that wrap ANY command without changing it: `scripts/run-backup-with-status.sh` and `scripts/run-restore-test-with-status.sh` (they call `scripts/backup-status.cjs`; inert unless called; tested only with stand-in commands).

**Who applies it:** the person with server access who owns the backup schedule.

**Steps**
1. Create the status directory on the host and mount it into the API container read-only, e.g. host `/var/lib/waseet/` (owner: the backup user, mode 750; the status file is written with mode 640 so the API's group can read it). No credentials ever go into this file.
2. Set `BACKUP_STATUS_FILE=/var/lib/waseet/backup-status.json` (container path as mounted) in the API environment, and optionally `BACKUP_STALE_HOURS` / `RESTORE_TEST_STALE_DAYS`. Redeploy the API.
3. Wrap the existing backup command (cron example; the command and artifact path are the job's own):
```
BACKUP_STATUS_FILE=/var/lib/waseet/backup-status.json BACKUP_ARTIFACT=/root/backups/waseetai-$(date +%F).dump \
  /opt/waseet/scripts/run-backup-with-status.sh -- /root/backups/existing-backup-command.sh
```
   systemd: put the same `Environment=` lines in the service and `ExecStart=/opt/waseet/scripts/run-backup-with-status.sh -- /root/backups/existing-backup-command.sh`. Jenkins: the same line in the shell step; the build result is the wrapped command's own exit code.
4. Weekly restore test: restore the newest dump into a THROW-AWAY database (a scratch database that is created for the test and dropped afterwards; never the live or a shared one), check schema or row counts, then:
```
BACKUP_STATUS_FILE=/var/lib/waseet/backup-status.json RESTORE_TEST_CHECK=ROW_COUNTS_OK \
  /opt/waseet/scripts/run-restore-test-with-status.sh -- /root/backups/existing-restore-test.sh
```
5. **Verify:** in the admin panel, backups page, «حالة النسخ الاحتياطي» changes from «غير متاح / NO_DATA» to «سليمة» with the time and size after the first successful run, and «حالة اختبار الاستعادة» after the first restore test. A deliberate failing stand-in (`-- false`) shows «آخر محاولة فشلت» (do this only in a test environment).
6. **Rollback:** remove the wrapper from the cron/systemd/Jenkins line (the original command keeps working unchanged) and unset `BACKUP_STATUS_FILE`; the panel returns to «غير متاح».
