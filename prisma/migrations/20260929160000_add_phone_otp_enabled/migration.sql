-- NOT EXECUTED — do not run against wasit-pg-dev or production from a local
-- machine. Apply this from the server (matches schema.prisma's User.phoneOtpEnabled).

-- AlterTable
ALTER TABLE "users" ADD COLUMN     "phoneOtpEnabled" BOOLEAN NOT NULL DEFAULT false;
