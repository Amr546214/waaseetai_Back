ALTER TABLE "projects" ADD COLUMN "serviceCatalogId" TEXT;
ALTER TABLE "reviews" ADD COLUMN "serviceId" TEXT;
ALTER TABLE "service_catalogs"
  ADD COLUMN "isFeatured" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "discountPercentage" INTEGER,
  ADD COLUMN "offerEndsAt" TIMESTAMP(3);

CREATE TABLE "marketplace_favorites" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "serviceId" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "marketplace_favorites_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "projects_serviceCatalogId_idx" ON "projects"("serviceCatalogId");
CREATE INDEX "reviews_serviceId_idx" ON "reviews"("serviceId");
CREATE INDEX "reviews_projectId_idx" ON "reviews"("projectId");
CREATE UNIQUE INDEX "marketplace_favorites_userId_serviceId_key" ON "marketplace_favorites"("userId", "serviceId");
CREATE INDEX "marketplace_favorites_serviceId_idx" ON "marketplace_favorites"("serviceId");

ALTER TABLE "projects" ADD CONSTRAINT "projects_serviceCatalogId_fkey"
  FOREIGN KEY ("serviceCatalogId") REFERENCES "service_catalogs"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "reviews" ADD CONSTRAINT "reviews_providerId_fkey"
  FOREIGN KEY ("providerId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "reviews" ADD CONSTRAINT "reviews_clientId_fkey"
  FOREIGN KEY ("clientId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "reviews" ADD CONSTRAINT "reviews_projectId_fkey"
  FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "reviews" ADD CONSTRAINT "reviews_serviceId_fkey"
  FOREIGN KEY ("serviceId") REFERENCES "service_catalogs"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "marketplace_favorites" ADD CONSTRAINT "marketplace_favorites_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "marketplace_favorites" ADD CONSTRAINT "marketplace_favorites_serviceId_fkey"
  FOREIGN KEY ("serviceId") REFERENCES "service_catalogs"("id") ON DELETE CASCADE ON UPDATE CASCADE;
