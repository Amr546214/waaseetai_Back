-- AlterTable
ALTER TABLE "client_profiles" ADD COLUMN     "avatarUrl" TEXT,
ADD COLUMN     "completionPercentage" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "currentLevel" TEXT DEFAULT 'مستكشف - المستوى 1',
ADD COLUMN     "currentPoints" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "firstName" TEXT,
ADD COLUMN     "lastName" TEXT,
ADD COLUMN     "pointsToNextLevel" INTEGER DEFAULT 100;

-- AlterTable
ALTER TABLE "provider_profiles" ADD COLUMN     "avatarUrl" TEXT,
ADD COLUMN     "firstName" TEXT,
ADD COLUMN     "lastName" TEXT;

-- AlterTable
ALTER TABLE "affiliate_profiles" ADD COLUMN     "firstName" TEXT,
ADD COLUMN     "lastName" TEXT;

