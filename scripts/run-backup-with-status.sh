#!/usr/bin/env bash
# Wraps ANY backup command and records its outcome in the status file the admin panel reads. Inert unless called.
# It does not change the command: it runs it as given, then records ONLY the exit code and the size of the produced artifact.
#
#   BACKUP_STATUS_FILE=/var/lib/waseet/backup-status.json \
#   BACKUP_ARTIFACT=/root/backups/waseetai-$(date +%F).dump \
#   scripts/run-backup-with-status.sh -- <your backup command and arguments>
#
# success  = command exited 0 AND the artifact exists and is not empty  -> records lastSuccessAt + size
# failure  = anything else                                              -> records a coarse code (BACKUP_FAILURE_CODE if it is one of the allowed codes, else DUMP_FAILED)
# The restore test is recorded separately by run-restore-test-with-status.sh; this wrapper never touches those fields.
# The wrapper prints one short line and never prints paths, commands or error text. Exit status = the wrapped command's own (2 on misuse).
set -u
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
[ -n "${BACKUP_STATUS_FILE:-}" ] || { echo "backup-status: BACKUP_STATUS_FILE is not set; nothing was run" >&2; exit 2; }
[ "${1:-}" = "--" ] || { echo "backup-status: usage: run-backup-with-status.sh -- <command...>; nothing was run" >&2; exit 2; }
shift; [ "$#" -gt 0 ] || { echo "backup-status: no command given; nothing was run" >&2; exit 2; }
"$@"; rc=$?
node_bin="${NODE_BIN:-node}"
if [ "$rc" -eq 0 ] && [ -n "${BACKUP_ARTIFACT:-}" ] && [ -s "$BACKUP_ARTIFACT" ]; then
	size="$(wc -c < "$BACKUP_ARTIFACT" | tr -d ' ')"
	"$node_bin" "$here/backup-status.cjs" backup success "$size" >/dev/null 2>&1 && echo "backup-status: success recorded" || echo "backup-status: could not write the status file" >&2
else
	code="${BACKUP_FAILURE_CODE:-DUMP_FAILED}"
	"$node_bin" "$here/backup-status.cjs" backup failure "$code" >/dev/null 2>&1 && echo "backup-status: failure recorded" || echo "backup-status: could not write the status file" >&2
	[ "$rc" -eq 0 ] && rc=1
fi
exit "$rc"
