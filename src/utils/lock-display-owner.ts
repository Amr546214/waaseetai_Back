import type { Prisma } from '@prisma/client';

/** Same profile-before-user order as identity decisions; a legacy profile save and a username change cannot cross their writes. */
export async function lockDisplayOwner(tx: Prisma.TransactionClient, userId: string): Promise<void> {
  // Test doubles that never open a database may omit raw SQL; the production Prisma client always provides it.
  if (typeof tx.$queryRaw !== 'function') return;
  await tx.$queryRaw`SELECT 1 FROM client_profiles WHERE "userId" = ${userId} FOR UPDATE`;
  await tx.$queryRaw`SELECT 1 FROM provider_profiles WHERE "userId" = ${userId} FOR UPDATE`;
  await tx.$queryRaw`SELECT 1 FROM affiliate_profiles WHERE "userId" = ${userId} FOR UPDATE`;
  await tx.$queryRaw`SELECT id FROM users WHERE id = ${userId} FOR UPDATE`;
}
