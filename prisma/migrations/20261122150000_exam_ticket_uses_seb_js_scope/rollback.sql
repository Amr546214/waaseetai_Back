-- Reverse of migration.sql. Remove the SEB challenge rows first (they would violate the narrower check); they are single-use records with a short expiry, nothing depends on them.
BEGIN;
DELETE FROM "exam_ticket_uses" WHERE "scope" = 'SEB_JS_CHALLENGE';
ALTER TABLE "exam_ticket_uses" DROP CONSTRAINT IF EXISTS "exam_ticket_uses_scope_check";
ALTER TABLE "exam_ticket_uses" ADD CONSTRAINT "exam_ticket_uses_scope_check" CHECK ("scope" = 'SETUP_TEST');
COMMIT;
