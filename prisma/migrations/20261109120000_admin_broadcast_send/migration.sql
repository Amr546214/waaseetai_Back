-- Admin broadcast: server-side drafts, confirmed idempotent in-platform sends, per-recipient status. Additive only.
CREATE TYPE "BroadcastAudience" AS ENUM ('CLIENTS', 'PROVIDERS', 'MARKETERS');
CREATE TYPE "BroadcastStatus" AS ENUM ('QUEUED', 'SENDING', 'PARTIAL', 'COMPLETED', 'FAILED');
CREATE TYPE "BroadcastRecipientStatus" AS ENUM ('PENDING', 'SENT', 'FAILED');

CREATE TABLE "broadcast_drafts" (
  "id" TEXT PRIMARY KEY,
  "ownerId" TEXT NOT NULL REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  "title" VARCHAR(150) NOT NULL,
  "message" TEXT NOT NULL CHECK (char_length("message") <= 2000),
  "category" "NotificationCategory" NOT NULL DEFAULT 'ALL',
  "audience" "BroadcastAudience",
  "version" INTEGER NOT NULL DEFAULT 1,
  "sentAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL
);
CREATE INDEX "broadcast_drafts_ownerId_updatedAt_idx" ON "broadcast_drafts" ("ownerId", "updatedAt");

CREATE TABLE "broadcasts" (
  "id" TEXT PRIMARY KEY,
  "draftId" TEXT REFERENCES "broadcast_drafts"("id") ON DELETE SET NULL ON UPDATE CASCADE,
  "senderId" TEXT NOT NULL REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  "senderName" VARCHAR(160) NOT NULL,
  "title" VARCHAR(150) NOT NULL,
  "message" TEXT NOT NULL CHECK (char_length("message") BETWEEN 1 AND 2000),
  "category" "NotificationCategory" NOT NULL,
  "audience" "BroadcastAudience" NOT NULL,
  "audienceCount" INTEGER NOT NULL CHECK ("audienceCount" > 0),
  "audienceHash" VARCHAR(64) NOT NULL,
  "previewCheckedAt" TIMESTAMP(3) NOT NULL,
  "idempotencyKey" VARCHAR(100) NOT NULL,
  "requestDigest" VARCHAR(64) NOT NULL,
  "status" "BroadcastStatus" NOT NULL DEFAULT 'QUEUED',
  "leaseOwner" VARCHAR(64),
  "leaseUntil" TIMESTAMP(3),
  "heartbeatAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "completedAt" TIMESTAMP(3)
);
CREATE UNIQUE INDEX "broadcasts_draftId_key" ON "broadcasts" ("draftId");
CREATE UNIQUE INDEX "broadcasts_senderId_idempotencyKey_key" ON "broadcasts" ("senderId", "idempotencyKey");
CREATE INDEX "broadcasts_createdAt_id_idx" ON "broadcasts" ("createdAt", "id");
CREATE INDEX "broadcasts_status_leaseUntil_idx" ON "broadcasts" ("status", "leaseUntil");

CREATE TABLE "broadcast_recipients" (
  "id" TEXT PRIMARY KEY,
  "broadcastId" TEXT NOT NULL REFERENCES "broadcasts"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  "userId" TEXT NOT NULL,
  "status" "BroadcastRecipientStatus" NOT NULL DEFAULT 'PENDING',
  "errorCode" VARCHAR(64),
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX "broadcast_recipients_broadcastId_userId_key" ON "broadcast_recipients" ("broadcastId", "userId");
CREATE INDEX "broadcast_recipients_broadcastId_status_id_idx" ON "broadcast_recipients" ("broadcastId", "status", "id");

-- Second line of defence behind the recipient row + broadcast lock: the database itself refuses a second notification of one broadcast for one user.
CREATE UNIQUE INDEX "notifications_admin_broadcast_once" ON "notifications" (("metadata"->>'broadcastId'), "userId") WHERE "type" = 'ADMIN_BROADCAST';
