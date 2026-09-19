-- Extends SensitiveFieldType with the banking fields that are already
-- presented as "governed" (AI review + human approval) in the Affiliate
-- profile UI, but previously had no ProfileChangeRequest coverage: only IBAN
-- created a request, while bankName/accountHolderName/swiftCode were applied
-- immediately. Purely additive — no existing enum value is renamed or
-- removed, no table is altered, no data is touched.
ALTER TYPE "SensitiveFieldType" ADD VALUE IF NOT EXISTS 'BANK_NAME';
ALTER TYPE "SensitiveFieldType" ADD VALUE IF NOT EXISTS 'ACCOUNT_HOLDER_NAME';
ALTER TYPE "SensitiveFieldType" ADD VALUE IF NOT EXISTS 'SWIFT_CODE';
