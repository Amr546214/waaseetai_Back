-- Admin team messaging: three NEW tables, nothing existing is altered. NOT EXECUTED on dev until approved.
-- Rollback (only if no message must be kept): DROP TABLE admin_messages, admin_conversation_members, admin_conversations;

-- CreateTable
CREATE TABLE "admin_conversations" (
    "id" TEXT NOT NULL,
    "pairKey" VARCHAR(80) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastMessageAt" TIMESTAMP(3),

    CONSTRAINT "admin_conversations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "admin_conversation_members" (
    "id" TEXT NOT NULL,
    "conversationId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "lastReadSeq" BIGINT NOT NULL DEFAULT 0,
    "joinedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "admin_conversation_members_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "admin_messages" (
    "id" TEXT NOT NULL,
    "conversationId" TEXT NOT NULL,
    "senderId" TEXT NOT NULL,
    "clientMessageId" VARCHAR(64) NOT NULL,
    "body" TEXT NOT NULL,
    "seq" BIGSERIAL NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "admin_messages_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "admin_conversations_pairKey_key" ON "admin_conversations"("pairKey");
CREATE INDEX "admin_conversations_lastMessageAt_idx" ON "admin_conversations"("lastMessageAt");
CREATE UNIQUE INDEX "admin_conversation_members_conversationId_userId_key" ON "admin_conversation_members"("conversationId", "userId");
CREATE INDEX "admin_conversation_members_userId_idx" ON "admin_conversation_members"("userId");
CREATE UNIQUE INDEX "admin_messages_seq_key" ON "admin_messages"("seq");
CREATE UNIQUE INDEX "admin_messages_conversationId_senderId_clientMessageId_key" ON "admin_messages"("conversationId", "senderId", "clientMessageId");
CREATE INDEX "admin_messages_conversationId_seq_idx" ON "admin_messages"("conversationId", "seq");

-- AddForeignKey
ALTER TABLE "admin_conversation_members" ADD CONSTRAINT "admin_conversation_members_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "admin_conversations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "admin_conversation_members" ADD CONSTRAINT "admin_conversation_members_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "admin_messages" ADD CONSTRAINT "admin_messages_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "admin_conversations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "admin_messages" ADD CONSTRAINT "admin_messages_senderId_fkey" FOREIGN KEY ("senderId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
