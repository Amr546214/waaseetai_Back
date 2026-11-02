-- Site identity («التحكم بالموقع» > الهوية): managed, versioned logos / favicon / AI icon / characters, stored in the database (bytea).
-- NOT EXECUTED on any shared environment (dev / prod / ARB). Rehearsed only on a throw-away local database (see qa-final-2026-10-14/site-control/IDENTITY-BE-REHEARSAL-2026-10-27.md).
-- ADDITIVE ONLY: three NEW tables, one new foreign key between them, indexes. No existing table, column, row or setting is read, altered or written.
-- Nothing is seeded: an empty `site_identity_state` means "every key is the built-in default asset" = the identity published today (no visual change by applying this file).
-- Apply order on a shared environment (coordinator): restore-verified backup -> this file -> BE image. The BE code tolerates the tables being absent (public manifest answers "all defaults").
-- Rollback: rollback.sql next to this file (drops the three tables; custom assets uploaded after the migration are lost, so take a pg_dump of the three tables first).

-- CreateTable
CREATE TABLE "site_identity_assets" (
    "id" UUID NOT NULL,
    "key" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "status" TEXT NOT NULL,
    "mime" TEXT NOT NULL,
    "bytes" BYTEA,
    "sha256" TEXT NOT NULL,
    "width" INTEGER,
    "height" INTEGER,
    "byteSize" INTEGER NOT NULL,
    "note" TEXT,
    "createdById" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "site_identity_assets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "site_identity_state" (
    "key" TEXT NOT NULL,
    "activeAssetId" UUID,
    "version" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedById" TEXT,

    CONSTRAINT "site_identity_state_pkey" PRIMARY KEY ("key")
);

-- CreateTable
CREATE TABLE "site_identity_manifest" (
    "version" INTEGER NOT NULL,
    "snapshot" JSONB NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" TEXT,
    "reason" TEXT NOT NULL,

    CONSTRAINT "site_identity_manifest_pkey" PRIMARY KEY ("version")
);

-- CreateIndex
CREATE UNIQUE INDEX "site_identity_assets_key_version_key" ON "site_identity_assets"("key", "version");
CREATE INDEX "site_identity_assets_key_status_idx" ON "site_identity_assets"("key", "status");
CREATE INDEX "site_identity_assets_key_sha256_idx" ON "site_identity_assets"("key", "sha256");

-- AddForeignKey (the active pointer can never reference a deleted row; PUBLISHED / SUPERSEDED rows are never deleted)
ALTER TABLE "site_identity_state" ADD CONSTRAINT "site_identity_state_activeAssetId_fkey" FOREIGN KEY ("activeAssetId") REFERENCES "site_identity_assets"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Integrity rules Prisma cannot express (defence in depth: the service enforces the same rules).
ALTER TABLE "site_identity_assets" ADD CONSTRAINT "site_identity_assets_status_check" CHECK ("status" IN ('STAGED', 'PUBLISHED', 'SUPERSEDED', 'DISCARDED'));
ALTER TABLE "site_identity_assets" ADD CONSTRAINT "site_identity_assets_version_check" CHECK ("version" >= 1 AND "byteSize" >= 0);
-- bytes may only be absent on a DISCARDED staged upload (its bytes are dropped); every other row must carry its bytes.
ALTER TABLE "site_identity_assets" ADD CONSTRAINT "site_identity_assets_bytes_check" CHECK ("bytes" IS NOT NULL OR "status" = 'DISCARDED');
-- at most ONE published asset per key.
CREATE UNIQUE INDEX "site_identity_assets_one_published_per_key" ON "site_identity_assets"("key") WHERE "status" = 'PUBLISHED';
