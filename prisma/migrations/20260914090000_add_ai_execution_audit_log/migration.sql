-- CreateTable
CREATE TABLE "ai_execution_audit_logs" (
    "id" TEXT NOT NULL,
    "executionId" TEXT NOT NULL,
    "capability" TEXT NOT NULL,
    "operation" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "modelPurpose" TEXT NOT NULL,
    "promptId" TEXT,
    "promptVersion" TEXT,
    "schemaId" TEXT,
    "schemaVersion" TEXT,
    "success" BOOLEAN NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "latencyMs" INTEGER NOT NULL DEFAULT 0,
    "promptTokens" INTEGER,
    "completionTokens" INTEGER,
    "totalTokens" INTEGER,
    "errorCode" TEXT,
    "providerStatusCode" INTEGER,
    "failurePolicy" TEXT,
    "fallbackType" TEXT,
    "actorUserId" TEXT,
    "primaryEntityType" TEXT,
    "primaryEntityId" TEXT,
    "relatedEntityRefs" JSONB,
    "redactionVersion" TEXT NOT NULL DEFAULT 'v1',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ai_execution_audit_logs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ai_execution_audit_logs_executionId_key" ON "ai_execution_audit_logs"("executionId");

-- CreateIndex
CREATE INDEX "ai_execution_audit_logs_capability_operation_createdAt_idx" ON "ai_execution_audit_logs"("capability", "operation", "createdAt");

-- CreateIndex
CREATE INDEX "ai_execution_audit_logs_actorUserId_createdAt_idx" ON "ai_execution_audit_logs"("actorUserId", "createdAt");

-- CreateIndex
CREATE INDEX "ai_execution_audit_logs_primaryEntityType_primaryEntityId_createdAt_idx" ON "ai_execution_audit_logs"("primaryEntityType", "primaryEntityId", "createdAt");
