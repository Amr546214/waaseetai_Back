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

## Where the backup job lives (findings, 2026-11-09, from local/offline evidence only)
- **Not in the backend or frontend repository.** No script, compose service, Jenkinsfile, cron or systemd file runs a backup. `DEPLOYMENT.md` only documents a manual `pg_dump` command; `git log` has no commit that introduces or maintains a backup job (the only "restore" commits are site-identity version restore, unrelated).
- **Found only in ops notes:** `ops/DISK-CLEANUP-PROPOSAL-20261019.md` says dumps live under `/root/backups` on the server and must not be deleted; the local `ops/backups-local/` holds `dev-pre-*` and `waseetai-dev-db-*.dump` snapshots taken before changes. No schedule, script or owner is named anywhere. So the job (if scheduled at all) lives on the server or in an external scheduler.
- **Owner:** by role, whoever has server access and owns the backup schedule (the same person/team that runs the dev deploy scripts). No individual is named because nothing in git or the notes shows who runs it; git authorship of the monitoring commits is not evidence of ownership.

## HANDOFF: linking the real backup job to the panel (NOT applied by this change; roles only, no individuals)

### What the owner of the server must do (5 lines)
1. Create a status directory on the host (example `/var/lib/waseet/backup-status/`), mode 0755, owned by the user that runs the backup job.
2. Run the backup through `scripts/run-backup-with-status.sh` and the restore test through `scripts/run-restore-test-with-status.sh` (same commands, just wrapped; the job's internals do not change).
3. Start the backend container with the directory mounted READ-ONLY and `BACKUP_STATUS_FILE` pointing at the container path.
4. Do the dry run below first (scratch directory, harmless command), then wire the real job.
5. Check the panel (backups page): NO_DATA becomes OK after the first run; rollback = remove the wrapper and the variable.

### Why the path matters
`BACKUP_STATUS_FILE` is read by the **backend container**, so it must be a path *inside the container* that is a bind mount of the host directory the job writes to. A path that only exists on the host is invisible to the app and the panel stays «غير متاح». The path is never shown in any API or UI.

### Permissions (from the backend Dockerfile/entrypoint)
The production image has no `USER` directive and the entrypoint does not drop privileges, so the API runs as **root (uid 0)** and can read anything. Recommended anyway, so it keeps working if a non-root user is added later:
- directory `0755`, owned by the backup job's user;
- status file `0644` (the writer creates it with that mode; the file holds no secrets);
- the writer replaces the file by **atomic rename inside the same directory** (temp file next to it), so the directory must be writable by the job's user and the mount must NOT be a single-file bind mount (a rename would break it): mount the **directory**;
- no secrets, paths, hostnames or error text are ever written to the file (only enumerated codes, times and a size).
Mount flag is read-only for the container: the app never writes there.

### Container run command (add to the existing one; adapt names)
```
docker run ... \
  -v /var/lib/waseet/backup-status:/var/lib/waseet/backup-status:ro \
  -e BACKUP_STATUS_FILE=/var/lib/waseet/backup-status/backup-status.json \
  -e BACKUP_STALE_HOURS=36 -e RESTORE_TEST_STALE_DAYS=8 \
  ...
```
(compose: `volumes: ["/var/lib/waseet/backup-status:/var/lib/waseet/backup-status:ro"]` and the same two `environment` entries.)

### Link the job (cron example; the command and artifact path are the job's own)
The job writes the status file on the HOST at `/var/lib/waseet/backup-status/backup-status.json`:
```
BACKUP_STATUS_FILE=/var/lib/waseet/backup-status/backup-status.json \
BACKUP_ARTIFACT=/root/backups/waseetai-$(date +%F).dump \
  /opt/waseet/scripts/run-backup-with-status.sh -- /path/to/the/existing/backup-command [its arguments]

# weekly, restoring ONLY into a throw-away database that the test creates and drops
BACKUP_STATUS_FILE=/var/lib/waseet/backup-status/backup-status.json RESTORE_TEST_CHECK=ROW_COUNTS_OK \
  /opt/waseet/scripts/run-restore-test-with-status.sh -- /path/to/the/existing/restore-test-command [its arguments]
```
systemd: `Environment=` lines as above and `ExecStart=/opt/waseet/scripts/run-backup-with-status.sh -- <command>`. Jenkins: the same line in the shell step. The wrapper's exit status is the wrapped command's own, so alerting that already watches the job keeps working. `/opt/waseet/scripts/` is wherever you copy `scripts/run-*.sh` and `scripts/backup-status.cjs` (keep the three files together; Node must be available on the host).

### Dry run BEFORE touching the real job (harmless, scratch directory)
```
d=$(mktemp -d); echo data > "$d/artifact.dump"
BACKUP_STATUS_FILE="$d/s.json" BACKUP_ARTIFACT="$d/artifact.dump" scripts/run-backup-with-status.sh -- true     # expect: "backup-status: success recorded"
BACKUP_STATUS_FILE="$d/s.json" scripts/run-restore-test-with-status.sh -- true                                   # expect: "restore-status: pass recorded"
BACKUP_STATUS_FILE="$d/s.json" BACKUP_ARTIFACT="$d/missing" scripts/run-backup-with-status.sh -- true           # expect: failure recorded, exit 1
cat "$d/s.json"; rm -rf "$d"
```
No real backup or restore runs in the dry run.

### Verify in the panel (backups page, admin)
- Before: «حالة النسخ الاحتياطي» = «غير متاح» (NO_DATA) with the contract text.
- After the first real backup: «سليمة»; **last successful backup time and its size (MB)** and its age are shown; after the first restore test: **last restore-test time and its result** are shown, **separately** from the backup.
- «قديمة» (STALE) when the last success is older than `BACKUP_STALE_HOURS` (36 h) or the last restore test older than `RESTORE_TEST_STALE_DAYS` (8 days); «آخر محاولة فشلت» when a newer failed attempt exists; «ملف الحالة غير صالح» when the file is corrupt, oversized (> 8 KB), has unknown keys or future times.

### Rollback
Remove the wrapper from the cron/systemd/Jenkins line (the original command keeps working untouched), then remove `BACKUP_STATUS_FILE` and the mount from the container and redeploy. The panel returns to «غير متاح». The status file can be deleted safely.
