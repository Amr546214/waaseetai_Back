CREATE TABLE "dispute_messages" (
    "id" TEXT NOT NULL,
    "disputeId" TEXT NOT NULL,
    "authorId" TEXT,
    "authorKind" TEXT NOT NULL CHECK ("authorKind" IN ('PARTICIPANT', 'STAFF')),
    "body" TEXT NOT NULL CHECK (length(btrim("body")) BETWEEN 1 AND 2000),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "dispute_messages_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "dispute_messages_disputeId_fkey" FOREIGN KEY ("disputeId") REFERENCES "disputes"("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "dispute_messages_authorId_fkey" FOREIGN KEY ("authorId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE
);

CREATE INDEX "dispute_messages_disputeId_createdAt_id_idx" ON "dispute_messages"("disputeId", "createdAt", "id");
