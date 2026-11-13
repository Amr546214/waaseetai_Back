-- CreateTable
CREATE TABLE "admin_expenses" (
    "id" TEXT NOT NULL,
    "requestKey" TEXT NOT NULL,
    "payloadHash" TEXT NOT NULL,
    "amount" DECIMAL(18,2) NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'USD',
    "category" VARCHAR(40) NOT NULL,
    "description" VARCHAR(1000) NOT NULL,
    "reference" VARCHAR(160),
    "incurredAt" TIMESTAMP(3) NOT NULL,
    "status" VARCHAR(20) NOT NULL DEFAULT 'RECORDED',
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdById" TEXT NOT NULL,
    "voidedById" TEXT,
    "voidReason" VARCHAR(500),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "admin_expenses_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "admin_content_pages" (
    "slug" VARCHAR(60) NOT NULL,
    "title" VARCHAR(160) NOT NULL,
    "draft" TEXT NOT NULL,
    "published" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "publishedAt" TIMESTAMP(3),
    "updatedById" TEXT NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "admin_content_pages_pkey" PRIMARY KEY ("slug")
);

-- CreateTable
CREATE TABLE "admin_broadcasts" (
    "id" TEXT NOT NULL,
    "requestKey" TEXT NOT NULL,
    "title" VARCHAR(150) NOT NULL,
    "message" VARCHAR(4000) NOT NULL,
    "audience" VARCHAR(40) NOT NULL,
    "status" VARCHAR(24) NOT NULL DEFAULT 'DRAFT',
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdById" TEXT NOT NULL,
    "recipientCount" INTEGER NOT NULL DEFAULT 0,
    "sentCount" INTEGER NOT NULL DEFAULT 0,
    "failedCount" INTEGER NOT NULL DEFAULT 0,
    "snapshotAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "admin_broadcasts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "admin_broadcast_deliveries" (
    "id" TEXT NOT NULL,
    "broadcastId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "notificationId" TEXT NOT NULL,
    "status" VARCHAR(20) NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "lastError" VARCHAR(500),
    "deliveredAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "admin_broadcast_deliveries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "cashback_reviews" (
    "id" TEXT NOT NULL,
    "contractId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "eligibleValue" DECIMAL(18,2) NOT NULL,
    "level" INTEGER NOT NULL,
    "ratePercent" DOUBLE PRECISION NOT NULL,
    "paymentInput" DOUBLE PRECISION,
    "paymentNote" VARCHAR(500),
    "reviewedById" TEXT,
    "status" VARCHAR(40) NOT NULL DEFAULT 'WAITING_PAYMENT_SCORE',
    "version" INTEGER NOT NULL DEFAULT 1,
    "completedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "cashback_reviews_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "admin_expenses_requestKey_key" ON "admin_expenses"("requestKey");

-- CreateIndex
CREATE INDEX "admin_expenses_status_incurredAt_id_idx" ON "admin_expenses"("status", "incurredAt", "id");

-- CreateIndex
CREATE UNIQUE INDEX "admin_broadcasts_requestKey_key" ON "admin_broadcasts"("requestKey");

-- CreateIndex
CREATE INDEX "admin_broadcasts_status_createdAt_idx" ON "admin_broadcasts"("status", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "admin_broadcast_deliveries_notificationId_key" ON "admin_broadcast_deliveries"("notificationId");

-- CreateIndex
CREATE INDEX "admin_broadcast_deliveries_broadcastId_status_id_idx" ON "admin_broadcast_deliveries"("broadcastId", "status", "id");

-- CreateIndex
CREATE UNIQUE INDEX "admin_broadcast_deliveries_broadcastId_userId_key" ON "admin_broadcast_deliveries"("broadcastId", "userId");

-- CreateIndex
CREATE UNIQUE INDEX "cashback_reviews_contractId_key" ON "cashback_reviews"("contractId");

-- CreateIndex
CREATE INDEX "cashback_reviews_status_completedAt_id_idx" ON "cashback_reviews"("status", "completedAt", "id");

-- CreateIndex
CREATE INDEX "cashback_reviews_userId_status_idx" ON "cashback_reviews"("userId", "status");

-- AddForeignKey
ALTER TABLE "admin_broadcast_deliveries" ADD CONSTRAINT "admin_broadcast_deliveries_broadcastId_fkey" FOREIGN KEY ("broadcastId") REFERENCES "admin_broadcasts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


ALTER TABLE "admin_expenses" ADD CONSTRAINT "admin_expenses_valid" CHECK (amount > 0 AND currency = 'USD' AND status IN ('RECORDED','VOIDED') AND category IN ('HOSTING','AI','SOFTWARE','OPERATIONS','OTHER'));
ALTER TABLE "cashback_reviews" ADD CONSTRAINT "cashback_reviews_score" CHECK ("paymentInput" IS NULL OR ("paymentInput" >= 0 AND "paymentInput" <= 100));
ALTER TABLE "cashback_reviews" ADD CONSTRAINT "cashback_reviews_status" CHECK (status IN ('WAITING_PAYMENT_SCORE','WAITING_RATING','CREDITED'));
ALTER TABLE "admin_broadcasts" ADD CONSTRAINT "admin_broadcasts_status" CHECK (status IN ('DRAFT','SENDING','COMPLETED','CANCELLED'));
ALTER TABLE "admin_broadcast_deliveries" ADD CONSTRAINT "admin_broadcast_deliveries_status" CHECK (status IN ('PENDING','SENT','FAILED'));
