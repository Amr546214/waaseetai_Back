-- CreateEnum
CREATE TYPE "ApprovalStatus" AS ENUM ('NONE', 'PENDING', 'APPROVED', 'REJECTED');

-- AlterTable
ALTER TABLE "coupons" ADD COLUMN     "approvalStatus" "ApprovalStatus" NOT NULL DEFAULT 'NONE',
ADD COLUMN     "assignedToTeamMemberId" TEXT,
ADD COLUMN     "createdByTeamMemberId" TEXT,
ADD COLUMN     "excludedServiceIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "internalNote" TEXT,
ADD COLUMN     "rejectionReason" TEXT;

-- CreateIndex
CREATE INDEX "coupons_assignedToTeamMemberId_idx" ON "coupons"("assignedToTeamMemberId");

-- CreateIndex
CREATE INDEX "coupons_createdByTeamMemberId_idx" ON "coupons"("createdByTeamMemberId");

-- CreateIndex
CREATE INDEX "coupons_providerId_approvalStatus_idx" ON "coupons"("providerId", "approvalStatus");

-- AddForeignKey
ALTER TABLE "coupons" ADD CONSTRAINT "coupons_assignedToTeamMemberId_fkey" FOREIGN KEY ("assignedToTeamMemberId") REFERENCES "company_team_members"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "coupons" ADD CONSTRAINT "coupons_createdByTeamMemberId_fkey" FOREIGN KEY ("createdByTeamMemberId") REFERENCES "company_team_members"("id") ON DELETE SET NULL ON UPDATE CASCADE;
