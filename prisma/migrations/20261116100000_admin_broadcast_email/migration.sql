ALTER TABLE admin_broadcasts ADD COLUMN "emailRequested" boolean NOT NULL DEFAULT false;
ALTER TABLE admin_broadcast_deliveries
 ADD COLUMN "emailStatus" varchar(20) NOT NULL DEFAULT 'SKIPPED',
 ADD COLUMN "emailAttempts" integer NOT NULL DEFAULT 0,
 ADD COLUMN "emailLeaseAt" timestamp(3),
 ADD COLUMN "emailNextAt" timestamp(3),
 ADD COLUMN "emailSentAt" timestamp(3),
 ADD COLUMN "emailError" varchar(500);
ALTER TABLE admin_broadcast_deliveries ADD CONSTRAINT broadcast_email_status_check CHECK ("emailStatus" IN ('SKIPPED','PENDING','SENDING','RETRY','SENT','FAILED','UNKNOWN','CANCELLED'));
CREATE INDEX admin_broadcast_deliveries_email_queue_idx ON admin_broadcast_deliveries("emailStatus", "emailNextAt");
