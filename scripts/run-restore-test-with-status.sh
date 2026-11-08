#!/usr/bin/env bash
# Wraps ANY restore-test command and records pass/fail in the status file the admin panel reads. Inert unless called.
# The command MUST restore into a THROW-AWAY database only (never the live or a shared one); this wrapper cannot check that, it only records the outcome.
#
#   BACKUP_STATUS_FILE=/var/lib/waseet/backup-status.json \
#   RESTORE_TEST_CHECK=ROW_COUNTS_OK \
#   scripts/run-restore-test-with-status.sh -- <your restore-test command and arguments>
#
# exit 0 -> pass with RESTORE_TEST_CHECK (SCHEMA_OK | ROW_COUNTS_OK | CHECKSUM_OK; default SCHEMA_OK)
# else   -> fail with RESTORE_TEST_FAIL_CHECK (RESTORE_FAILED | COUNT_MISMATCH; default RESTORE_FAILED)
# Only the restore-test fields are written; the backup fields are kept as they are. Prints one short line, never paths or error text. Exit status = the wrapped command's own (2 on misuse).
set -u
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
[ -n "${BACKUP_STATUS_FILE:-}" ] || { echo "restore-status: BACKUP_STATUS_FILE is not set; nothing was run" >&2; exit 2; }
[ "${1:-}" = "--" ] || { echo "restore-status: usage: run-restore-test-with-status.sh -- <command...>; nothing was run" >&2; exit 2; }
shift; [ "$#" -gt 0 ] || { echo "restore-status: no command given; nothing was run" >&2; exit 2; }
"$@"; rc=$?
node_bin="${NODE_BIN:-node}"
if [ "$rc" -eq 0 ]; then outcome=pass; check="${RESTORE_TEST_CHECK:-SCHEMA_OK}"; else outcome=fail; check="${RESTORE_TEST_FAIL_CHECK:-RESTORE_FAILED}"; fi
"$node_bin" "$here/backup-status.cjs" restore "$outcome" "$check" >/dev/null 2>&1 && echo "restore-status: $outcome recorded" || echo "restore-status: could not write the status file" >&2
exit "$rc"
