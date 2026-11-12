-- Rollback of 20261112110000_project_status_cancelled. NOT EXECUTED anywhere. Refuses while any project is CANCELLED (those rows would lose their state).
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "projects" WHERE "status" = 'CANCELLED') THEN
    RAISE EXCEPTION 'projects are still CANCELLED: they cannot be rolled back without losing their state';
  END IF;
END $$;
BEGIN;
ALTER TABLE "projects" ALTER COLUMN "status" DROP DEFAULT;
ALTER TYPE "ProjectStatus" RENAME TO "ProjectStatus_old";
CREATE TYPE "ProjectStatus" AS ENUM ('DRAFT','PENDING_SIGNATURE','PENDING_REVIEW','OPEN','IN_PROGRESS','AWAITING_DELIVERY','PENDING_APPROVAL','COMPLETED','DISPUTED');
ALTER TABLE "projects" ALTER COLUMN "status" TYPE "ProjectStatus" USING ("status"::text::"ProjectStatus");
ALTER TABLE "projects" ALTER COLUMN "status" SET DEFAULT 'OPEN';
DROP TYPE "ProjectStatus_old";
COMMIT;
