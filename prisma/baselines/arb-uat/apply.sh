#!/usr/bin/env bash
# Builds a NEW empty PostgreSQL database from the baseline and records the migration history. NOT for existing databases.
# usage: PSQL="docker exec -i <pg-container> psql -U <user> -d <db>" PRISMA="<command that runs prisma with DATABASE_URL set>" ./apply.sh
# Secrets are never printed: DATABASE_URL is read from the environment by $PRISMA, not passed as an argument.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
migrations="${MIGRATIONS_DIR:-$here/../../migrations}"
: "${PSQL:?PSQL command is required}" "${PRISMA:?PRISMA command is required}"

n=$($PSQL -At -v ON_ERROR_STOP=1 -c "SELECT count(*) FROM information_schema.tables WHERE table_schema='public'")
if [ "$n" != "0" ]; then echo "REFUSED: the database already has $n tables; this baseline is for an empty database only." >&2; exit 2; fi

echo "== applying baseline (one transaction)"
cat "$here/10-schema.generated.sql" "$here/20-non-prisma.sql" "$here/30-reference-data.sql" | $PSQL -v ON_ERROR_STOP=1 --single-transaction -q -f - >/dev/null

echo "== recording migration history (prisma migrate resolve --applied, $(ls -d "$migrations"/2* | wc -l | tr -d ' ') folders)"
for d in $(ls -d "$migrations"/2* | sort); do
  $PRISMA migrate resolve --applied "$(basename "$d")" >/dev/null
done
$PRISMA migrate status
