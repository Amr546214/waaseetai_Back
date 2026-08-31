ALTER TABLE "account_audit_logs"
  ADD COLUMN IF NOT EXISTS "eventType" TEXT,
  ADD COLUMN IF NOT EXISTS "source" TEXT,
  ADD COLUMN IF NOT EXISTS "severity" TEXT DEFAULT 'INFO',
  ADD COLUMN IF NOT EXISTS "summary" TEXT,
  ADD COLUMN IF NOT EXISTS "beforeData" JSONB,
  ADD COLUMN IF NOT EXISTS "afterData" JSONB,
  ADD COLUMN IF NOT EXISTS "context" JSONB,
  ADD COLUMN IF NOT EXISTS "requestId" TEXT,
  ADD COLUMN IF NOT EXISTS "sessionId" TEXT,
  ADD COLUMN IF NOT EXISTS "ipAddress" TEXT,
  ADD COLUMN IF NOT EXISTS "device" TEXT,
  ADD COLUMN IF NOT EXISTS "actorLabel" TEXT,
  ADD COLUMN IF NOT EXISTS "occurredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  ADD COLUMN IF NOT EXISTS "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

UPDATE "account_audit_logs"
SET
  "eventType" = COALESCE("eventType", CASE
    WHEN "category" = 'ROLE_ADDITION' THEN 'ROLE_ADDED'
    WHEN "category" = 'PROFILE_COMPLETION' THEN 'PROFILE_UPDATED'
    WHEN "category" = 'SECURITY_CHANGE' THEN 'SECURITY_CHANGED'
    ELSE 'SYSTEM_EVENT'
  END),
  "source" = COALESCE("source", 'SYSTEM'),
  "summary" = COALESCE("summary", "actionText"),
  "occurredAt" = COALESCE("occurredAt", "createdAt");

CREATE INDEX IF NOT EXISTS "account_audit_logs_userId_occurredAt_idx" ON "account_audit_logs"("userId", "occurredAt");
CREATE INDEX IF NOT EXISTS "account_audit_logs_eventType_idx" ON "account_audit_logs"("eventType");
CREATE INDEX IF NOT EXISTS "account_audit_logs_source_idx" ON "account_audit_logs"("source");
CREATE INDEX IF NOT EXISTS "account_audit_logs_requestId_idx" ON "account_audit_logs"("requestId");
CREATE INDEX IF NOT EXISTS "account_audit_logs_sessionId_idx" ON "account_audit_logs"("sessionId");

-- Import existing governed profile requests without copying their sensitive payloads.
INSERT INTO "account_audit_logs" (
  "id", "userId", "category", "title", "actionText", "status", "statusText",
  "canResubmit", "eventType", "source", "severity", "summary", "requestId",
  "occurredAt", "updatedAt", "createdAt"
)
SELECT
  'migration-' || r."id", r."providerId",
  CASE WHEN r."category" = 'SECURITY' THEN 'SECURITY_CHANGE'::"LogCategory" ELSE 'PROFILE_COMPLETION'::"LogCategory" END,
  r."fieldLabel",
  CASE WHEN r."status" = 'APPROVED' THEN 'تم اعتماد وتطبيق الطلب'
       WHEN r."status" = 'REJECTED' THEN 'تم رفض الطلب'
       ELSE 'طلب تعديل قيد المعالجة' END,
  CASE WHEN r."status" = 'APPROVED' THEN 'APPROVED'::"LogStatus"
       WHEN r."status" = 'REJECTED' THEN 'REJECTED'::"LogStatus"
       WHEN r."status" IN ('CANCELLED') THEN 'COMPLETED'::"LogStatus"
       ELSE 'IN_REVIEW'::"LogStatus" END,
  COALESCE(r."aiRecommendation", r."rejectionReason"), false,
  'SENSITIVE_CHANGE_MIGRATED',
  CASE WHEN r."reviewedByAdmin" THEN 'ADMIN' ELSE 'SYSTEM' END,
  CASE WHEN r."status" = 'REJECTED' THEN 'WARNING' ELSE 'INFO' END,
  CASE WHEN r."status" = 'APPROVED' THEN 'تم اعتماد وتطبيق طلب تعديل سابق'
       WHEN r."status" = 'REJECTED' THEN 'تم رفض طلب تعديل سابق'
       ELSE 'طلب تعديل سابق قيد المعالجة' END,
  r."id", COALESCE(r."appliedAt", r."updatedAt", r."createdAt"), CURRENT_TIMESTAMP, r."createdAt"
FROM "profile_modification_requests" r
WHERE NOT EXISTS (
  SELECT 1 FROM "account_audit_logs" a
  WHERE a."requestId" = r."id" AND a."eventType" = 'SENSITIVE_CHANGE_MIGRATED'
);
