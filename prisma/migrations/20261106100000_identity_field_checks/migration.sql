-- ADDITIVE ONLY. NOT EXECUTED on dev/prod: the team applies it after a backup. New enums + one new table; no existing table or column is touched.
CREATE TYPE "IdentityFieldCheckStatus" AS ENUM ('QUEUED', 'RUNNING', 'DONE', 'UNAVAILABLE', 'SKIPPED');
CREATE TYPE "IdentityCheckParty" AS ENUM ('CLIENT', 'PROVIDER');

CREATE TABLE "identity_field_checks" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "party" "IdentityCheckParty" NOT NULL,
    "seq" INTEGER NOT NULL,
    "imageVersion" INTEGER NOT NULL,
    "imageRefDigest" TEXT NOT NULL,
    "imageSha256" TEXT,
    "dataDigest" TEXT NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "status" "IdentityFieldCheckStatus" NOT NULL DEFAULT 'QUEUED',
    "stateReason" TEXT,
    "registeredSnapshot" JSONB,
    "nationalIdMasked" TEXT,
    "fieldResults" JSONB,
    "modelName" TEXT,
    "modelVersion" TEXT,
    "aiRequestId" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "startedAt" TIMESTAMP(3),
    "finishedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "identity_field_checks_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "identity_field_checks_idempotencyKey_key" ON "identity_field_checks"("idempotencyKey");
CREATE UNIQUE INDEX "identity_field_checks_userId_party_seq_key" ON "identity_field_checks"("userId", "party", "seq");
CREATE INDEX "identity_field_checks_userId_party_idx" ON "identity_field_checks"("userId", "party");

ALTER TABLE "identity_field_checks" ADD CONSTRAINT "identity_field_checks_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
