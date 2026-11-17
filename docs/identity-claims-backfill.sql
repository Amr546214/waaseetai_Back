-- NOT EXECUTED. Run by the team, after a backup, AFTER prisma/migrations/20261119100000_identity_claims is applied.
-- Purpose: accounts whose identity was approved BEFORE the "one identity, one account" rule existed get their claim, so a second account cannot reuse that number.
-- The digest below is the same as src/services/identity-claim.service.ts (identityClaimDigest): sha256('waseet-identity-claim:v1|' || COUNTRY || '|' || NUMBER)
-- with the number upper-cased, letters/digits only, Arabic-Indic digits converted. The document type is not part of it.

-- 1) READ-ONLY conflict report: numbers that already sit on MORE THAN ONE approved account. Review these by hand first (do not insert them blindly).
WITH approved AS (
  SELECT cp."userId", 'CLIENT'::text AS party, upper(coalesce(cp."idIssuingCountry", '')) AS country,
         upper(regexp_replace(translate(coalesce(cp."idNumber", ''), '٠١٢٣٤٥٦٧٨٩۰۱۲۳۴۵۶۷۸۹', '01234567890123456789'), '[^[:alnum:]]', '', 'g')) AS num
  FROM client_profiles cp WHERE cp."kycStatus" = 'VERIFIED'
  UNION ALL
  SELECT pp."userId", 'PROVIDER', upper(coalesce(pp."idIssuingCountry", '')),
         upper(regexp_replace(translate(coalesce(pp."idNumber", ''), '٠١٢٣٤٥٦٧٨٩۰۱۲۳۴۵۶۷۸۹', '01234567890123456789'), '[^[:alnum:]]', '', 'g'))
  FROM provider_profiles pp WHERE pp."kycStatus" = 'VERIFIED'
)
SELECT country, num, count(DISTINCT "userId") AS accounts, array_agg(DISTINCT "userId") AS user_ids
FROM approved WHERE length(num) >= 5 GROUP BY country, num HAVING count(DISTINCT "userId") > 1;

-- 2) BACKFILL: one claim per number; where an old duplicate exists the OLDEST account (users."createdAt") keeps it. Idempotent.
INSERT INTO identity_claims ("digest", "userId", "party")
SELECT DISTINCT ON (digest) digest, "userId", party FROM (
  SELECT encode(sha256(convert_to('waseet-identity-claim:v1|' || country || '|' || num, 'UTF8')), 'hex') AS digest, a."userId", a.party::"IdentityCheckParty" AS party, u."createdAt" AS created
  FROM (
    SELECT cp."userId", 'CLIENT' AS party, upper(coalesce(cp."idIssuingCountry", '')) AS country,
           upper(regexp_replace(translate(coalesce(cp."idNumber", ''), '٠١٢٣٤٥٦٧٨٩۰۱۲۳۴۵۶۷۸۹', '01234567890123456789'), '[^[:alnum:]]', '', 'g')) AS num
    FROM client_profiles cp WHERE cp."kycStatus" = 'VERIFIED'
    UNION ALL
    SELECT pp."userId", 'PROVIDER', upper(coalesce(pp."idIssuingCountry", '')),
           upper(regexp_replace(translate(coalesce(pp."idNumber", ''), '٠١٢٣٤٥٦٧٨٩۰۱۲۳۴۵۶۷۸۹', '01234567890123456789'), '[^[:alnum:]]', '', 'g'))
    FROM provider_profiles pp WHERE pp."kycStatus" = 'VERIFIED'
  ) a JOIN users u ON u.id = a."userId"
  WHERE length(a.num) >= 5
) x ORDER BY digest, created
ON CONFLICT (digest) DO NOTHING;
