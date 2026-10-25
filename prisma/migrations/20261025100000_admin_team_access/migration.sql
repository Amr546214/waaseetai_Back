-- Admin team: platform owner, roles (permission templates), staff, invitations, tasks, access audit.
-- ADDITIVE ONLY: seven new tables and six new enums. No existing table or column is touched, nothing is backfilled, NO account is made owner and NO role is given to anybody here.
-- PREPARED, NOT EXECUTED on any shared database. The owner is designated separately (scripts/set-platform-owner.ts) after the owner confirms the account id.
-- CreateEnum
CREATE TYPE "AdminStaffStatus" AS ENUM ('ACTIVE', 'SUSPENDED');

-- CreateEnum
CREATE TYPE "AdminInviteStatus" AS ENUM ('PENDING', 'ACCEPTED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "AdminTaskStatus" AS ENUM ('NEW', 'IN_PROGRESS', 'PENDING', 'DONE', 'CANCELLED');

-- CreateEnum
CREATE TYPE "AdminTaskPriority" AS ENUM ('URGENT', 'HIGH', 'MEDIUM', 'NORMAL', 'LOW');

-- CreateEnum
CREATE TYPE "AdminTaskType" AS ENUM ('DISPUTE', 'REPORT', 'SUPPORT', 'APPROVAL', 'FINANCE', 'DOCUMENT');

-- CreateTable
CREATE TABLE "platform_owner" (
    "id" INTEGER NOT NULL DEFAULT 1,
    "userId" TEXT NOT NULL,
    "designatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "designatedBy" VARCHAR(120) NOT NULL,

    CONSTRAINT "platform_owner_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "admin_roles" (
    "id" TEXT NOT NULL,
    "name" VARCHAR(80) NOT NULL,
    "nameKey" VARCHAR(80) NOT NULL,
    "description" VARCHAR(300),
    "color" VARCHAR(9) NOT NULL DEFAULT '#2BD4C7',
    "permissions" TEXT[],
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "admin_roles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "admin_staff" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "roleId" TEXT,
    "status" "AdminStaffStatus" NOT NULL DEFAULT 'ACTIVE',
    "title" VARCHAR(120),
    "invitedById" TEXT,
    "joinedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "suspendedAt" TIMESTAMP(3),
    "version" INTEGER NOT NULL DEFAULT 1,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "admin_staff_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "admin_invites" (
    "id" TEXT NOT NULL,
    "email" VARCHAR(254) NOT NULL,
    "fullName" VARCHAR(120) NOT NULL,
    "roleId" TEXT NOT NULL,
    "invitedById" TEXT NOT NULL,
    "tokenHash" VARCHAR(64) NOT NULL,
    "status" "AdminInviteStatus" NOT NULL DEFAULT 'PENDING',
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "acceptedAt" TIMESTAMP(3),
    "acceptedUserId" TEXT,
    "cancelledAt" TIMESTAMP(3),
    "resendCount" INTEGER NOT NULL DEFAULT 0,
    "lastSentAt" TIMESTAMP(3),
    "verifyCodeHash" VARCHAR(64),
    "verifyCodeExpiresAt" TIMESTAMP(3),
    "verifyCodeSentAt" TIMESTAMP(3),
    "verifySendCount" INTEGER NOT NULL DEFAULT 0,
    "verifyAttempts" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "admin_invites_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "admin_tasks" (
    "id" TEXT NOT NULL,
    "number" SERIAL NOT NULL,
    "title" VARCHAR(200) NOT NULL,
    "description" VARCHAR(2000),
    "type" "AdminTaskType" NOT NULL,
    "priority" "AdminTaskPriority" NOT NULL DEFAULT 'NORMAL',
    "status" "AdminTaskStatus" NOT NULL DEFAULT 'NEW',
    "dueAt" TIMESTAMP(3),
    "assigneeId" TEXT,
    "createdById" TEXT NOT NULL,
    "linkType" VARCHAR(20),
    "linkId" VARCHAR(64),
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "admin_tasks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "admin_task_events" (
    "id" TEXT NOT NULL,
    "taskId" TEXT NOT NULL,
    "actorId" TEXT NOT NULL,
    "kind" VARCHAR(30) NOT NULL,
    "fromValue" VARCHAR(60),
    "toValue" VARCHAR(60),
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "admin_task_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "admin_access_audit" (
    "id" TEXT NOT NULL,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "actorId" TEXT NOT NULL,
    "action" VARCHAR(40) NOT NULL,
    "subjectUserId" TEXT,
    "roleId" TEXT,
    "inviteId" TEXT,
    "before" JSONB,
    "after" JSONB,

    CONSTRAINT "admin_access_audit_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "platform_owner_userId_key" ON "platform_owner"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "admin_roles_nameKey_key" ON "admin_roles"("nameKey");

-- CreateIndex
CREATE UNIQUE INDEX "admin_staff_userId_key" ON "admin_staff"("userId");

-- CreateIndex
CREATE INDEX "admin_staff_roleId_idx" ON "admin_staff"("roleId");

-- CreateIndex
CREATE INDEX "admin_staff_status_idx" ON "admin_staff"("status");

-- CreateIndex
CREATE UNIQUE INDEX "admin_invites_tokenHash_key" ON "admin_invites"("tokenHash");

-- CreateIndex
CREATE INDEX "admin_invites_email_idx" ON "admin_invites"("email");

-- CreateIndex
CREATE INDEX "admin_invites_status_expiresAt_idx" ON "admin_invites"("status", "expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "admin_tasks_number_key" ON "admin_tasks"("number");

-- CreateIndex
CREATE INDEX "admin_tasks_assigneeId_status_idx" ON "admin_tasks"("assigneeId", "status");

-- CreateIndex
CREATE INDEX "admin_tasks_status_dueAt_idx" ON "admin_tasks"("status", "dueAt");

-- CreateIndex
CREATE INDEX "admin_task_events_taskId_at_idx" ON "admin_task_events"("taskId", "at");

-- CreateIndex
CREATE INDEX "admin_access_audit_at_idx" ON "admin_access_audit"("at");

-- CreateIndex
CREATE INDEX "admin_access_audit_subjectUserId_idx" ON "admin_access_audit"("subjectUserId");

-- CreateIndex
CREATE INDEX "admin_access_audit_action_idx" ON "admin_access_audit"("action");

-- AddForeignKey
ALTER TABLE "platform_owner" ADD CONSTRAINT "platform_owner_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "admin_staff" ADD CONSTRAINT "admin_staff_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "admin_staff" ADD CONSTRAINT "admin_staff_roleId_fkey" FOREIGN KEY ("roleId") REFERENCES "admin_roles"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "admin_invites" ADD CONSTRAINT "admin_invites_roleId_fkey" FOREIGN KEY ("roleId") REFERENCES "admin_roles"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "admin_tasks" ADD CONSTRAINT "admin_tasks_assigneeId_fkey" FOREIGN KEY ("assigneeId") REFERENCES "admin_staff"("userId") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "admin_task_events" ADD CONSTRAINT "admin_task_events_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "admin_tasks"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- ── objects Prisma cannot express ──────────────────────────────────────────────────────────────────────────────────────────────────────
-- Exactly one platform owner: the single row must have id = 1.
ALTER TABLE "platform_owner" ADD CONSTRAINT "platform_owner_single_row" CHECK ("id" = 1);
-- One PENDING invitation per e-mail address (the e-mail is stored lower-cased by the application).
CREATE UNIQUE INDEX "ux_admin_invites_one_pending_per_email" ON "admin_invites"("email") WHERE "status" = 'PENDING';

-- Backstop for the single-owner rule, independent of any application route: the owner row cannot be changed or removed, and the owner's account cannot be suspended / banned /
-- re-typed or deleted by any statement. Changing ownership is out of scope and needs a deliberate DBA action (drop the trigger, change, recreate it).
CREATE OR REPLACE FUNCTION "waseet_protect_platform_owner"() RETURNS trigger AS $$
BEGIN
  IF TG_TABLE_NAME = 'platform_owner' THEN
    IF TG_OP = 'INSERT' THEN RETURN NEW; END IF;
    RAISE EXCEPTION 'OWNER_PROTECTED: platform_owner is immutable' USING ERRCODE = 'P0001';
  END IF;
  IF TG_OP = 'DELETE' THEN
    IF EXISTS (SELECT 1 FROM "platform_owner" WHERE "userId" = OLD."id") THEN RAISE EXCEPTION 'OWNER_PROTECTED: the owner account cannot be deleted' USING ERRCODE = 'P0001'; END IF;
    RETURN OLD;
  END IF;
  IF EXISTS (SELECT 1 FROM "platform_owner" WHERE "userId" = OLD."id")
     AND (NEW."status" IS DISTINCT FROM OLD."status" OR NEW."isBanned" IS DISTINCT FROM OLD."isBanned" OR NEW."accountType" IS DISTINCT FROM OLD."accountType") THEN
    RAISE EXCEPTION 'OWNER_PROTECTED: the owner account cannot be suspended, banned or re-typed' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;

CREATE TRIGGER "platform_owner_immutable" BEFORE UPDATE OR DELETE ON "platform_owner" FOR EACH ROW EXECUTE FUNCTION "waseet_protect_platform_owner"();
CREATE TRIGGER "users_owner_protected" BEFORE UPDATE OR DELETE ON "users" FOR EACH ROW EXECUTE FUNCTION "waseet_protect_platform_owner"();
