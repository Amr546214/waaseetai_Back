-- NOT EXECUTED. Additive and idempotent: one nullable column on "users", no change to any existing row.
-- The legal name = the name on the official identity document (the ONLY name compared with the document). It is separate from firstName/lastName,
-- which stay the display name people see on the platform. NULL = not provided yet (older accounts and Google sign-ups): they are asked to provide it when they verify.
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "legalName" VARCHAR(120);
