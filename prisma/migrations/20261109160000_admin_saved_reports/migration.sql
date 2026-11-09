CREATE TABLE "admin_saved_reports" (
  "id" TEXT NOT NULL,
  "ownerId" TEXT NOT NULL,
  "name" VARCHAR(80) NOT NULL,
  "section" VARCHAR(20) NOT NULL,
  "period" VARCHAR(10) NOT NULL,
  "from" VARCHAR(10),
  "to" VARCHAR(10),
  "compare" BOOLEAN NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "admin_saved_reports_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "admin_saved_reports_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "admin_saved_reports_ownerId_createdAt_id_idx" ON "admin_saved_reports" ("ownerId", "createdAt", "id");
