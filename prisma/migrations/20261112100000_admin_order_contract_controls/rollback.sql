-- Rollback of 20261112100000_admin_order_contract_controls. NOT EXECUTED anywhere. Refuses while any request is suspended / cancelled by an admin, any offer is suspended or any contract is frozen
-- (dropping the columns would silently lift a hold). Clear those first through the admin screens.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "client_requests" WHERE "adminSuspendedAt" IS NOT NULL OR "adminCancelledAt" IS NOT NULL)
     OR EXISTS (SELECT 1 FROM "project_proposals" WHERE "adminSuspendedAt" IS NOT NULL)
     OR EXISTS (SELECT 1 FROM "contracts" WHERE "adminFrozenAt" IS NOT NULL) THEN
    RAISE EXCEPTION 'admin holds are still active: resume / unfreeze them before rolling back';
  END IF;
END $$;
DROP TABLE IF EXISTS "admin_action_idempotency";
ALTER TABLE "contracts" DROP COLUMN IF EXISTS "adminFrozenAt", DROP COLUMN IF EXISTS "adminFrozenById", DROP COLUMN IF EXISTS "adminFreezeReason";
ALTER TABLE "project_proposals" DROP COLUMN IF EXISTS "adminSuspendedAt", DROP COLUMN IF EXISTS "adminSuspendedById", DROP COLUMN IF EXISTS "adminSuspendReason";
ALTER TABLE "client_requests" DROP COLUMN IF EXISTS "adminSuspendedAt", DROP COLUMN IF EXISTS "adminSuspendedById", DROP COLUMN IF EXISTS "adminSuspendReason", DROP COLUMN IF EXISTS "adminCancelledAt", DROP COLUMN IF EXISTS "adminCancelledById", DROP COLUMN IF EXISTS "adminCancelReason";
