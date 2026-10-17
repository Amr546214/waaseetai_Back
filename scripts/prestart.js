const { execSync } = require('child_process');

console.log('🔄 [prestart] Generating Prisma Client...');
execSync('npx prisma generate', { stdio: 'inherit' });
console.log('✅ [prestart] Prisma Client generated successfully.');

if (process.env.RUN_DB_MIGRATIONS === 'true') {
  console.log('🔄 [prestart] RUN_DB_MIGRATIONS=true — applying Prisma migrations...');
  execSync('npx prisma migrate deploy', { stdio: 'inherit' });
  console.log('✅ [prestart] Database migrations applied successfully.');
} else if (process.env.RUN_DB_PUSH === 'true') {
  console.log('🔄 [prestart] RUN_DB_PUSH=true — synchronizing Prisma schema...');
  const pushCmd = process.env.RUN_DB_PUSH_ACCEPT_DATA_LOSS === 'true'
    ? 'npx prisma db push --accept-data-loss'
    : 'npx prisma db push';
  execSync(pushCmd, { stdio: 'inherit' });
  console.log('✅ [prestart] Prisma schema synchronized successfully.');
} else {
  console.log('ℹ️ [prestart] RUN_DB_MIGRATIONS and RUN_DB_PUSH are both false (or unset) — skipping automatic schema mutation.');
}
