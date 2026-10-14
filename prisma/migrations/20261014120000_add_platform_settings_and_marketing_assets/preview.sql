-- PREVIEW ONLY — read-only checks around the migration. NOT EXECUTED anywhere. The change itself is migration.sql (additive: 2 new tables + 1 index; no existing table touched).
-- 1) Before: both tables must be absent (expected: 0 rows).
SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_name IN ('platform_settings', 'marketing_assets');
-- 2) Apply migration.sql, then expected: 2 rows.
-- 3) After: structure + empty content (expected: 0 and 0).
SELECT column_name, data_type FROM information_schema.columns WHERE table_name = 'platform_settings' ORDER BY ordinal_position;
SELECT count(*) FROM platform_settings;
SELECT count(*) FROM marketing_assets;
-- Rollback: rollback.sql (DROP TABLE of both; they only hold admin-entered settings / marketing material, nothing else references them).
