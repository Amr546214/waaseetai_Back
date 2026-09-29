-- CreateEnum
CREATE TYPE "SpecialOfferType" AS ENUM ('BUNDLE', 'DIRECT_DISCOUNT');

-- CreateTable
CREATE TABLE "special_offers" (
    "id" TEXT NOT NULL,
    "providerId" TEXT NOT NULL,
    "type" "SpecialOfferType" NOT NULL,
    "name" TEXT NOT NULL,
    "primaryServiceId" TEXT,
    "beneficiaryServiceId" TEXT,
    "targetServiceId" TEXT,
    "discountValue" DOUBLE PRECISION NOT NULL,
    "validityDays" INTEGER,
    "startAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3),
    "badgeText" TEXT NOT NULL,
    "customerMessage" TEXT,
    "internalNote" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "usedCount" INTEGER NOT NULL DEFAULT 0,
    "assignedToTeamMemberId" TEXT,
    "createdByTeamMemberId" TEXT,
    "approvalStatus" "ApprovalStatus" NOT NULL DEFAULT 'NONE',
    "rejectionReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "special_offers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "special_offer_redemptions" (
    "id" TEXT NOT NULL,
    "offerId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "amount" DOUBLE PRECISION NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "special_offer_redemptions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "special_offers_providerId_approvalStatus_idx" ON "special_offers"("providerId", "approvalStatus");

-- CreateIndex
CREATE INDEX "special_offers_primaryServiceId_idx" ON "special_offers"("primaryServiceId");

-- CreateIndex
CREATE INDEX "special_offers_beneficiaryServiceId_idx" ON "special_offers"("beneficiaryServiceId");

-- CreateIndex
CREATE INDEX "special_offers_targetServiceId_idx" ON "special_offers"("targetServiceId");

-- CreateIndex
CREATE INDEX "special_offers_assignedToTeamMemberId_idx" ON "special_offers"("assignedToTeamMemberId");

-- CreateIndex
CREATE INDEX "special_offers_createdByTeamMemberId_idx" ON "special_offers"("createdByTeamMemberId");

-- CreateIndex
CREATE INDEX "special_offer_redemptions_offerId_userId_idx" ON "special_offer_redemptions"("offerId", "userId");

-- CreateIndex
CREATE INDEX "special_offer_redemptions_orderId_idx" ON "special_offer_redemptions"("orderId");

-- CreateIndex
CREATE UNIQUE INDEX "special_offer_redemptions_offerId_userId_orderId_key" ON "special_offer_redemptions"("offerId", "userId", "orderId");

-- AddForeignKey
ALTER TABLE "special_offers" ADD CONSTRAINT "special_offers_providerId_fkey" FOREIGN KEY ("providerId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "special_offers" ADD CONSTRAINT "special_offers_primaryServiceId_fkey" FOREIGN KEY ("primaryServiceId") REFERENCES "service_catalogs"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "special_offers" ADD CONSTRAINT "special_offers_beneficiaryServiceId_fkey" FOREIGN KEY ("beneficiaryServiceId") REFERENCES "service_catalogs"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "special_offers" ADD CONSTRAINT "special_offers_targetServiceId_fkey" FOREIGN KEY ("targetServiceId") REFERENCES "service_catalogs"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "special_offers" ADD CONSTRAINT "special_offers_assignedToTeamMemberId_fkey" FOREIGN KEY ("assignedToTeamMemberId") REFERENCES "company_team_members"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "special_offers" ADD CONSTRAINT "special_offers_createdByTeamMemberId_fkey" FOREIGN KEY ("createdByTeamMemberId") REFERENCES "company_team_members"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "special_offer_redemptions" ADD CONSTRAINT "special_offer_redemptions_offerId_fkey" FOREIGN KEY ("offerId") REFERENCES "special_offers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "special_offer_redemptions" ADD CONSTRAINT "special_offer_redemptions_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "special_offer_redemptions" ADD CONSTRAINT "special_offer_redemptions_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "orders"("id") ON DELETE CASCADE ON UPDATE CASCADE;

