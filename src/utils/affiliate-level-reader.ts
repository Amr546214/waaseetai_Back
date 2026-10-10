import type { prisma as PrismaClientInstance } from '../config/db';
import { logger } from '../config/logger';
import { levelDef, levelColor, MIN_LEVEL } from '../config/levels.config';

/**
 * The numeric AffiliateProfile.level, read on its own (never part of the safe scalar select: a database that has not got the column yet answers
 * "level 1" instead of failing the page). The stored currentLevel / commissionRatePercentage strings are stale labels and are NOT used.
 */
export async function readAffiliateLevels(ids: string[], client: Pick<typeof PrismaClientInstance, 'affiliateProfile'>): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  if (!ids.length) return out;
  try {
    const rows = await client.affiliateProfile.findMany({ where: { id: { in: ids } }, select: { id: true, level: true } });
    for (const r of rows) out.set(r.id, Number.isInteger(r.level) ? r.level : MIN_LEVEL);
  } catch (error) {
    logger.error('[affiliate-level] could not read AffiliateProfile.level; treated as level 1', error);
  }
  return out;
}

/** Name, percentage and colours of an affiliate level, all from the single ladder. */
export function affiliateLevelInfo(level: number | null | undefined) {
  const def = levelDef('MARKETER', Number.isInteger(level) ? (level as number) : MIN_LEVEL);
  return { level: def.level, name: def.name, commissionPercent: def.percent, color: { dark: levelColor('MARKETER', def.level, 'dark'), light: levelColor('MARKETER', def.level, 'light') } };
}
