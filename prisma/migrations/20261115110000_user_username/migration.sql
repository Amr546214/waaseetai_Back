-- NOT EXECUTED. Additive and idempotent: one nullable column on "users", no change to any existing row.
-- The username = the name the person uses to deal with others and appear on the platform (profile, cards, chat, search, notifications). One field, a single word is fine, NOT unique
-- and NOT a login identifier. It is separate from the LEGAL name ("legalName"), which only identity verification uses. NULL = not chosen yet (older accounts keep showing firstName/lastName).
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "username" VARCHAR(60);
