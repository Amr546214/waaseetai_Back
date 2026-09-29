#!/usr/bin/env bash
set -e

echo "=================================================="
echo "🚀 Starting Waseet AI Backend Container..."
echo "=================================================="

# Check database host and port from environment or the standalone compose service
DB_HOST="${DB_HOST:-postgres}"
DB_PORT="${DB_PORT:-5432}"

if [ -f "/usr/local/bin/wait-for-it" ]; then
  echo "📡 Waiting for database readiness at ${DB_HOST}:${DB_PORT}..."
  if /usr/local/bin/wait-for-it "${DB_HOST}:${DB_PORT}" --timeout=30 --strict -- echo "✅ Database connection established cleanly!"; then
    echo "🟢 Database is ready for queries."
  else
    echo "❌ Database did not become ready in time. Aborting startup."
    exit 1
  fi
else
  echo "ℹ️ wait-for-it not found in path, skipping DB port probe."
fi

echo "🔄 Generating Prisma Client..."
npx prisma generate
echo "✅ Prisma Client generated successfully."

if [ "${RUN_DB_MIGRATIONS:-false}" = "true" ]; then
  echo "🔄 Applying Prisma migrations..."
  npx prisma migrate deploy
  echo "✅ Database migrations applied successfully."
elif [ "${RUN_DB_PUSH:-false}" = "true" ]; then
  # Release invariant: automatic schema mutation on container start is
  # fail-closed by default. RUN_DB_MIGRATIONS and RUN_DB_PUSH both default
  # to false — a plain `docker compose up` never touches the database
  # schema. Set RUN_DB_PUSH=true explicitly only for a fresh/isolated
  # standalone database with no real migration history yet; set
  # RUN_DB_MIGRATIONS=true instead once the migration history is the
  # source of truth for that database.
  echo "🔄 Synchronizing Prisma schema for standalone deployment..."
  if [ "${RUN_DB_PUSH_ACCEPT_DATA_LOSS:-false}" = "true" ]; then
    echo "⚠️ Explicitly enabled: accepting Prisma schema diff warnings for bootstrap."
    npx prisma db push --accept-data-loss
  else
    npx prisma db push
  fi
  echo "✅ Prisma schema synchronized successfully."
else
  echo "ℹ️ Database schema synchronization disabled."
fi

echo "🚀 Launching application process..."
echo "=================================================="
exec "$@"
