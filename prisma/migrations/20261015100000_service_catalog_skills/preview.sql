-- PREVIEW ONLY: read-only checks around the migration. NOT EXECUTED anywhere. The change is migration.sql (additive: 1 column on service_catalogs).
-- 1) Before: the column must be absent (expected: 0 rows).
SELECT column_name FROM information_schema.columns WHERE table_name = 'service_catalogs' AND column_name = 'skills';
-- 2) Apply migration.sql, then expected: 1 row (ARRAY / text).
SELECT column_name, data_type FROM information_schema.columns WHERE table_name = 'service_catalogs' AND column_name = 'skills';
-- 3) After: every existing service has an empty list (expected: total = empty, with_skills = 0).
SELECT count(*) AS total, count(*) FILTER (WHERE cardinality(skills) = 0) AS empty, count(*) FILTER (WHERE cardinality(skills) > 0) AS with_skills FROM service_catalogs;
-- Rollback: rollback.sql.
