-- NOT EXECUTED ANYWHERE. EMERGENCY ONLY. Read MIGRATION-AND-OWNER-PLAN.md first.
--
-- Why it exists: the release BEFORE the permission system grants every ADMIN / SUPER_ADMIN account full access. If the application image ever has to go back to it, the platform must not
-- silently return to blanket access. Run this BEFORE the old image starts: it suspends every admin-type account except the owner (the owner row is protected and never touched). The owner then
-- re-activates people one by one once the new release is back. Keep the printed ids: they are the list to restore.
--
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -1 -f scripts/admin-rollback-freeze.sql      (output = the ids that were suspended)
--   restore one account:   UPDATE "users" SET "status" = 'ACTIVE' WHERE "id" = '<id from the list>';
BEGIN;
UPDATE "users" SET "status" = 'SUSPENDED_REVIEW'
 WHERE "accountType" IN ('ADMIN', 'SUPER_ADMIN') AND "status" = 'ACTIVE'
   AND "id" NOT IN (SELECT "userId" FROM "platform_owner")
RETURNING "id", "accountType";
UPDATE "user_sessions" SET "revokedAt" = now()
 WHERE "revokedAt" IS NULL AND "userId" IN (SELECT "id" FROM "users" WHERE "accountType" IN ('ADMIN', 'SUPER_ADMIN') AND "status" = 'SUSPENDED_REVIEW');
COMMIT;
