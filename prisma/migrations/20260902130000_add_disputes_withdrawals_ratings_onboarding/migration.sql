CREATE TYPE "DisputeStatus" AS ENUM ('OPEN', 'UNDER_REVIEW', 'RESOLVED', 'REJECTED');
CREATE TYPE "WithdrawalStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED', 'COMPLETED');
CREATE TYPE "OnboardingStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED');

ALTER TABLE "reviews" ADD COLUMN "clientRequestId" TEXT;

CREATE TABLE "disputes" (
    "id" TEXT NOT NULL,
    "requestId" TEXT,
    "projectId" TEXT,
    "openedById" TEXT NOT NULL,
    "againstUserId" TEXT,
    "resolvedById" TEXT,
    "status" "DisputeStatus" NOT NULL DEFAULT 'OPEN',
    "reason" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "evidence" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "resolution" TEXT,
    "resolutionNote" TEXT,
    "resolvedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "disputes_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "withdrawals" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "amount" DOUBLE PRECISION NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'SAR',
    "method" TEXT NOT NULL,
    "accountName" TEXT,
    "accountNumber" TEXT,
    "iban" TEXT,
    "status" "WithdrawalStatus" NOT NULL DEFAULT 'PENDING',
    "reviewedById" TEXT,
    "rejectionReason" TEXT,
    "adminNote" TEXT,
    "referenceId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "withdrawals_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "client_onboarding" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "documentUrl" TEXT NOT NULL,
    "documentName" TEXT NOT NULL,
    "documentType" TEXT NOT NULL,
    "status" "OnboardingStatus" NOT NULL DEFAULT 'PENDING',
    "rejectionReason" TEXT,
    "reviewedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "client_onboarding_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "withdrawals_referenceId_key" ON "withdrawals"("referenceId");
CREATE UNIQUE INDEX "client_onboarding_userId_key" ON "client_onboarding"("userId");
CREATE INDEX "reviews_clientRequestId_idx" ON "reviews"("clientRequestId");
CREATE INDEX "disputes_status_createdAt_idx" ON "disputes"("status", "createdAt");
CREATE INDEX "disputes_requestId_idx" ON "disputes"("requestId");
CREATE INDEX "disputes_projectId_idx" ON "disputes"("projectId");
CREATE INDEX "disputes_openedById_idx" ON "disputes"("openedById");
CREATE INDEX "withdrawals_status_createdAt_idx" ON "withdrawals"("status", "createdAt");
CREATE INDEX "withdrawals_userId_createdAt_idx" ON "withdrawals"("userId", "createdAt");

ALTER TABLE "reviews" ADD CONSTRAINT "reviews_clientRequestId_fkey" FOREIGN KEY ("clientRequestId") REFERENCES "client_requests"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "disputes" ADD CONSTRAINT "disputes_requestId_fkey" FOREIGN KEY ("requestId") REFERENCES "client_requests"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "disputes" ADD CONSTRAINT "disputes_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "disputes" ADD CONSTRAINT "disputes_openedById_fkey" FOREIGN KEY ("openedById") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "disputes" ADD CONSTRAINT "disputes_againstUserId_fkey" FOREIGN KEY ("againstUserId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "disputes" ADD CONSTRAINT "disputes_resolvedById_fkey" FOREIGN KEY ("resolvedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "withdrawals" ADD CONSTRAINT "withdrawals_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "withdrawals" ADD CONSTRAINT "withdrawals_reviewedById_fkey" FOREIGN KEY ("reviewedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "client_onboarding" ADD CONSTRAINT "client_onboarding_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
