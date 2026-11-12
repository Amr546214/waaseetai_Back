-- Rollback of 20261113100000_closure_events_cashback. NOT EXECUTED anywhere. Refuses while any closure, event-based commission or cashback row exists (they carry money facts).
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "engagement_closures") OR EXISTS (SELECT 1 FROM "client_cashback_entries")
     OR EXISTS (SELECT 1 FROM "commission_logs" WHERE "sourceEventId" IS NOT NULL) THEN
    RAISE EXCEPTION 'closure / cashback / event commission rows exist: they cannot be rolled back without losing money facts';
  END IF;
END $$;
DROP TABLE IF EXISTS "client_cashback_entries";
DROP INDEX IF EXISTS "commission_logs_event_key";
DROP INDEX IF EXISTS "commission_logs_sourceEventId_idx";
ALTER TABLE "commission_logs" DROP COLUMN IF EXISTS "sourceEventId";
DROP TABLE IF EXISTS "engagement_closures";
