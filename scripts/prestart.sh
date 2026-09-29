#!/usr/bin/env bash
set -e

# Release invariant: automatic schema mutation on startup is fail-closed by
# default. This used to be an unconditional `prisma migrate deploy` in
# package.json's own "prestart" hook, with no environment gate at all — it
# ran even if RUN_DB_MIGRATIONS/RUN_DB_PUSH were both explicitly set to
# false for the Docker entrypoint (scripts/docker-entrypoint.sh), because
# npm's prestart hook is a completely separate mechanism from that script.
# `npm start` (used by the "development" Dockerfile target and any bare
# host run) now goes through this same gate instead.

echo "🔄 [prestart] Generating Prisma Client..."
npx prisma generate
echo "✅ [prestart] Prisma Client generated successfully."

if [ "${RUN_DB_MIGRATIONS:-false}" = "true" ]; then
  echo "🔄 [prestart] RUN_DB_MIGRATIONS=true — applying Prisma migrations..."
  npx prisma migrate deploy
  echo "✅ [prestart] Database migrations applied successfully."
elif [ "${RUN_DB_PUSH:-false}" = "true" ]; then
  echo "🔄 [prestart] RUN_DB_PUSH=true — synchronizing Prisma schema..."
  if [ "${RUN_DB_PUSH_ACCEPT_DATA_LOSS:-false}" = "true" ]; then
    npx prisma db push --accept-data-loss
  else
    npx prisma db push
  fi
  echo "✅ [prestart] Prisma schema synchronized successfully."
else
  echo "ℹ️ [prestart] RUN_DB_MIGRATIONS and RUN_DB_PUSH are both false (or unset) — skipping automatic schema mutation."
fi
