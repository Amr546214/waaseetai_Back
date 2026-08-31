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

if [ "${RUN_DB_MIGRATIONS:-true}" = "true" ]; then
  echo "🔄 Applying Prisma migrations..."
  npx prisma migrate deploy
  echo "✅ Database migrations applied successfully."
else
  echo "ℹ️ Database migrations disabled by RUN_DB_MIGRATIONS."
fi

echo "🚀 Launching application process..."
echo "=================================================="
exec "$@"
