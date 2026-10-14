-- Additive only: two new tables, no change to existing data. NOT EXECUTED from the dev Mac; the team applies it on the server.
-- Rollback: rollback.sql (drops both tables; they hold only admin-entered settings / marketing material).
CREATE TABLE IF NOT EXISTS "platform_settings" (
    "key" TEXT NOT NULL,
    "value" JSONB NOT NULL,
    "updatedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "platform_settings_pkey" PRIMARY KEY ("key")
);

CREATE TABLE IF NOT EXISTS "marketing_assets" (
    "id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "kind" TEXT NOT NULL,
    "fileUrl" TEXT,
    "fileName" TEXT,
    "mimeType" TEXT,
    "fileBytes" INTEGER,
    "linkUrl" TEXT,
    "text" TEXT,
    "audience" TEXT NOT NULL DEFAULT 'MARKETER',
    "active" BOOLEAN NOT NULL DEFAULT true,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdBy" TEXT,
    "updatedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "marketing_assets_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "marketing_assets_active_audience_sortOrder_idx" ON "marketing_assets"("active", "audience", "sortOrder");
