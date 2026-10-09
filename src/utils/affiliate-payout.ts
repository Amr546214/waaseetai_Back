import type { prisma as PrismaClientInstance } from '../config/db';
import { logger } from '../config/logger';

// PayPal is the only payout destination for a marketer. AffiliateProfile still has the legacy bank columns (bankName, accountHolderName, iban,
// swiftCode, payoutMethod): they are never returned, shown or used (no migration, no data change).

/** The same row without the legacy bank columns. */
export function withoutLegacyAffiliateBankFields<T extends Record<string, any> | null | undefined>(row: T): T {
  if (!row) return row;
  const { bankName: _b, accountHolderName: _a, iban: _i, swiftCode: _s, payoutMethod: _p, ...rest } = row as Record<string, any>;
  return rest as T;
}

/**
 * The marketer's saved PayPal email. Read on its own (not part of AFFILIATE_PROFILE_SAFE_SCALAR_SELECT) so a database that has not got the
 * column yet answers null instead of failing the whole profile read.
 */
export async function readAffiliatePaypalEmail(userId: string, client: Pick<typeof PrismaClientInstance, 'affiliateProfile'>): Promise<string | null> {
  try {
    const row = await client.affiliateProfile.findUnique({ where: { userId }, select: { paypalPayoutEmail: true } });
    return row?.paypalPayoutEmail?.trim() || null;
  } catch (error) {
    logger.error(`[affiliate-payout] could not read paypalPayoutEmail (userId=${userId}); treated as not set`, error);
    return null;
  }
}
