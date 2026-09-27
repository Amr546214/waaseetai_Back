-- Batch 4F-B: retire the four legacy specialty-quiz models.
--
-- Proven runtime-unused across Batches 4A-4F-A: zero production read or
-- write path references any of these tables (only comment/test-name text
-- remained). Every foreign key below is owned by one of these four legacy
-- tables and points toward a surviving table (specialties, provider_specialties,
-- users) or another legacy table — none of the surviving tables' own rows,
-- columns, or constraints are affected by these drops.
--
-- Dropped in child-to-parent order so no explicit DROP CONSTRAINT / CASCADE
-- is required: PostgreSQL automatically drops every index, constraint (PK,
-- FK, unique) and sequence owned by a table as part of DROP TABLE on that
-- table itself.
--
-- NOTE: this migration authors the DDL only. It must NOT be applied to any
-- database until the four tables below have been backed up/archived
-- (Batch 4F-A found DEV row counts could not be verified in that session).

-- DropTable (references specialty_test_sessions; must go first)
DROP TABLE "test_question_submissions";

-- DropTable (references specialty_tests and provider_specialties; must go before specialty_tests)
DROP TABLE "test_submissions";

-- DropTable (no longer referenced by any table once test_question_submissions is gone)
DROP TABLE "specialty_test_sessions";

-- DropTable (no longer referenced by any table once test_submissions is gone)
DROP TABLE "specialty_tests";

-- DropEnum (used exclusively by specialty_test_sessions.status, now gone)
DROP TYPE "TestSessionStatus";
