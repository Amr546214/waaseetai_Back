import { randomInt } from 'crypto';

const SLUG_SUFFIX_LENGTH = 6;
const SLUG_NAME_MAX = 20;

// Random base36 suffix (36^6 ≈ 2.2 billion values). The old suffix was the last 4 characters of the user id, and an Arabic name has no Latin
// letters at all, so every such marketer got "user" + 4 hex chars (65k values) and collided on the unique referralSlug sooner or later.
function randomSuffix(): string {
  return randomInt(36 ** SLUG_SUFFIX_LENGTH).toString(36).padStart(SLUG_SUFFIX_LENGTH, '0');
}

// `userId` is kept only for call-site compatibility; uniqueness now comes from the random suffix plus the callers' P2002 retry.
export function generateReferralSlug(fullName: string | undefined | null, _userId?: string): string {
  const sanitized = (fullName || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '')
    .slice(0, SLUG_NAME_MAX);

  const namePart = sanitized.length > 0 ? sanitized : 'user';
  return `${namePart}${randomSuffix()}`;
}

/** True when a Prisma error is a unique-constraint violation on AffiliateProfile.referralSlug. */
export function isReferralSlugConflict(error: unknown): boolean {
  const e = error as { code?: string; meta?: { target?: unknown } } | null;
  if (e?.code !== 'P2002') return false;
  const target = e.meta?.target;
  const text = Array.isArray(target) ? target.join(',') : typeof target === 'string' ? target : '';
  // Some adapters omit the target: a P2002 raised while creating an affiliate profile is treated as a slug conflict (retry is harmless).
  return text === '' || /referralSlug/i.test(text);
}
