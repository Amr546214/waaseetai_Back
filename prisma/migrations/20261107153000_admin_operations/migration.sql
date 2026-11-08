ALTER TABLE "support_ticket_messages" ADD COLUMN "replyKey" TEXT, ADD COLUMN "replyDigest" TEXT;
CREATE UNIQUE INDEX "support_ticket_messages_replyKey_key" ON "support_ticket_messages"("replyKey");
ALTER TABLE "case_attachments" ADD COLUMN "messageId" TEXT;
ALTER TABLE "case_attachments" ADD CONSTRAINT "case_attachments_messageId_fkey" FOREIGN KEY ("messageId") REFERENCES "support_ticket_messages"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "case_attachments" ADD CONSTRAINT "case_attachment_message_requires_ticket" CHECK ("messageId" IS NULL OR "ticketId" IS NOT NULL);
CREATE INDEX "case_attachments_messageId_idx" ON "case_attachments"("messageId");
CREATE UNIQUE INDEX "account_audit_logs_one_automatic_case_escalation"
ON "account_audit_logs" ("eventType", (context->>'entityId'))
WHERE source = 'SYSTEM' AND "eventType" IN ('TICKET_ASSIGNED', 'DISPUTE_ASSIGNED');

CREATE TYPE "PlatformReportTarget" AS ENUM ('ACCOUNT', 'SERVICE');
CREATE TYPE "PlatformReportStatus" AS ENUM ('OPEN', 'RESOLVED', 'DISMISSED');
CREATE TABLE "platform_reports" (
  "id" TEXT PRIMARY KEY,
  "reporterId" TEXT NOT NULL REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  "targetType" "PlatformReportTarget" NOT NULL,
  "targetId" TEXT NOT NULL,
  "targetLabel" TEXT NOT NULL,
  "reason" TEXT NOT NULL,
  "status" "PlatformReportStatus" NOT NULL DEFAULT 'OPEN',
  "resolution" TEXT,
  "reviewerId" TEXT REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE,
  "reviewedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX "platform_reports_status_createdAt_id_idx" ON "platform_reports"("status", "createdAt", "id");
CREATE INDEX "platform_reports_reporterId_targetType_targetId_idx" ON "platform_reports"("reporterId", "targetType", "targetId");
CREATE UNIQUE INDEX "platform_reports_one_open_per_target" ON "platform_reports"("reporterId", "targetType", "targetId") WHERE "status" = 'OPEN';
