-- Stop all backend workers before rolling this schema back.
DO $$ BEGIN IF EXISTS (SELECT 1 FROM admin_broadcast_deliveries WHERE "emailStatus" IN ('PENDING','SENDING','RETRY')) THEN RAISE EXCEPTION 'Pending email deliveries: keep schema'; END IF; END $$;
DROP INDEX admin_broadcast_deliveries_email_queue_idx;
ALTER TABLE admin_broadcast_deliveries DROP CONSTRAINT broadcast_email_status_check, DROP COLUMN "emailStatus", DROP COLUMN "emailAttempts", DROP COLUMN "emailLeaseAt", DROP COLUMN "emailNextAt", DROP COLUMN "emailSentAt", DROP COLUMN "emailError";
ALTER TABLE admin_broadcasts DROP COLUMN "emailRequested";
