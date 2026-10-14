-- Rollback for 20261015100000_service_catalog_skills. NOT EXECUTED. Drops the skills column (only the skills picked on services are lost; run it only after the BE that writes it is rolled back).
ALTER TABLE "service_catalogs" DROP COLUMN IF EXISTS "skills";
