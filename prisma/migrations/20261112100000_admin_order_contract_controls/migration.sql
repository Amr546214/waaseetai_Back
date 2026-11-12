-- Admin order / contract controls. NOT EXECUTED on any shared database (dev / production): the team applies it on the server.
-- Additive and idempotent: nullable columns + one new table. No existing row changes; rollback.sql removes them.
ALTER TABLE "client_requests"
  ADD COLUMN IF NOT EXISTS "adminSuspendedAt"   TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "adminSuspendedById" TEXT,
  ADD COLUMN IF NOT EXISTS "adminSuspendReason" VARCHAR(500),
  ADD COLUMN IF NOT EXISTS "adminCancelledAt"   TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "adminCancelledById" TEXT,
  ADD COLUMN IF NOT EXISTS "adminCancelReason"  VARCHAR(500);

ALTER TABLE "project_proposals"
  ADD COLUMN IF NOT EXISTS "adminSuspendedAt"   TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "adminSuspendedById" TEXT,
  ADD COLUMN IF NOT EXISTS "adminSuspendReason" VARCHAR(500);

ALTER TABLE "contracts"
  ADD COLUMN IF NOT EXISTS "adminFrozenAt"     TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "adminFrozenById"   TEXT,
  ADD COLUMN IF NOT EXISTS "adminFreezeReason" VARCHAR(500);

CREATE TABLE IF NOT EXISTS "admin_action_idempotency" (
  "id"          TEXT NOT NULL,
  "adminId"     TEXT NOT NULL,
  "key"         VARCHAR(120) NOT NULL,
  "action"      VARCHAR(60) NOT NULL,
  "entityType"  VARCHAR(30) NOT NULL,
  "entityId"    TEXT NOT NULL,
  "requestHash" VARCHAR(64) NOT NULL,
  "response"    JSONB NOT NULL,
  "createdAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "admin_action_idempotency_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "admin_action_idempotency_adminId_key_key" ON "admin_action_idempotency" ("adminId", "key");
CREATE INDEX IF NOT EXISTS "admin_action_idempotency_entityType_entityId_idx" ON "admin_action_idempotency" ("entityType", "entityId");
