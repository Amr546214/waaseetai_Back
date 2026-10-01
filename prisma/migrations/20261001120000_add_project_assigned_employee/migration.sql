-- AlterTable
ALTER TABLE "projects" ADD COLUMN "assignedEmployeeId" TEXT;

-- CreateIndex
CREATE INDEX "projects_assignedEmployeeId_idx" ON "projects"("assignedEmployeeId");

-- AddForeignKey
ALTER TABLE "projects" ADD CONSTRAINT "projects_assignedEmployeeId_fkey" FOREIGN KEY ("assignedEmployeeId") REFERENCES "company_team_members"("id") ON DELETE SET NULL ON UPDATE CASCADE;
