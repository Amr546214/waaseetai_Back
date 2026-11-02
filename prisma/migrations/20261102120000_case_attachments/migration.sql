CREATE TABLE "case_attachments" (
  "id" TEXT PRIMARY KEY,
  "ticketId" TEXT REFERENCES "support_tickets"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  "disputeId" TEXT REFERENCES "disputes"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  "requestKey" TEXT,
  "digest" TEXT,
  "ownerId" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "mimeType" TEXT NOT NULL,
  "bytes" INTEGER NOT NULL CHECK ("bytes" > 0 AND "bytes" <= 10485760),
  "privateRef" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "case_attachment_one_parent" CHECK (("ticketId" IS NOT NULL)::integer + ("disputeId" IS NOT NULL)::integer = 1)
);
CREATE INDEX "case_attachments_ticketId_idx" ON "case_attachments"("ticketId");
CREATE INDEX "case_attachments_disputeId_idx" ON "case_attachments"("disputeId");

CREATE INDEX "case_attachments_disputeId_requestKey_idx" ON "case_attachments"("disputeId", "requestKey");
ALTER TABLE "support_tickets" ADD COLUMN "submissionKey" TEXT, ADD COLUMN "submissionDigest" TEXT;
CREATE UNIQUE INDEX "support_tickets_submissionKey_key" ON "support_tickets"("submissionKey");
