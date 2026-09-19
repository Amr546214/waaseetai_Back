-- Extends SensitiveFieldType so the Affiliate/Marketer governed
-- ProfileChangeRequest flow can cover FIRST_NAME and LAST_NAME, the same way
-- it already covers NATIONAL_ID/PHONE_NUMBER (User columns) and the banking
-- fields (AffiliateProfile columns). Purely additive — no existing enum
-- value is renamed or removed, no table is altered, no data is touched.
ALTER TYPE "SensitiveFieldType" ADD VALUE IF NOT EXISTS 'FIRST_NAME';
ALTER TYPE "SensitiveFieldType" ADD VALUE IF NOT EXISTS 'LAST_NAME';
