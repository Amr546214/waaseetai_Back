-- CreateEnum
CREATE TYPE "TeamMemberType" AS ENUM ('PROVIDER', 'EMPLOYEE');

-- CreateEnum
CREATE TYPE "TeamMemberStatus" AS ENUM ('ACTIVE', 'PENDING', 'INACTIVE');

-- CreateTable
CREATE TABLE "company_team_members" (
    "id" TEXT NOT NULL,
    "companyOwnerId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "phone" TEXT,
    "jobTitle" TEXT NOT NULL,
    "memberType" "TeamMemberType" NOT NULL,
    "status" "TeamMemberStatus" NOT NULL DEFAULT 'PENDING',
    "avatarUrl" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "company_team_members_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "company_team_members_companyOwnerId_memberType_status_idx" ON "company_team_members"("companyOwnerId", "memberType", "status");

-- CreateIndex
CREATE UNIQUE INDEX "company_team_members_companyOwnerId_email_key" ON "company_team_members"("companyOwnerId", "email");

-- AddForeignKey
ALTER TABLE "company_team_members" ADD CONSTRAINT "company_team_members_companyOwnerId_fkey" FOREIGN KEY ("companyOwnerId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

