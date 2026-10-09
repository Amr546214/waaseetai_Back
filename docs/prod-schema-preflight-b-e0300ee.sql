-- ============================================================================
-- NOT EXECUTED.  READ-ONLY preflight for PART B (DROPS of the 4 retired quiz
-- tables + enum).  Run right before part B (which itself is deferred until the
-- new backend is verified and no running backend still uses these tables):
--   psql -v ON_ERROR_STOP=1 -f prod-schema-preflight-b-e0300ee.sql
-- ============================================================================
\set ON_ERROR_STOP on
BEGIN READ ONLY;

DO $$
DECLARE
  n bigint;
  t text;
  fk_outside bigint;
BEGIN
  IF current_setting('server_version_num')::int < 120000 THEN
    RAISE EXCEPTION 'PREFLIGHT FAIL: PostgreSQL % is older than 12', current_setting('server_version');
  END IF;

  -- The four tables to drop must all be EMPTY (no data loss)
  FOREACH t IN ARRAY ARRAY['specialty_test_sessions','specialty_tests','test_question_submissions','test_submissions'] LOOP
    IF to_regclass('public.'||t) IS NULL THEN
      RAISE EXCEPTION 'PREFLIGHT FAIL: % does not exist (already dropped? part B not needed)', t;
    END IF;
    EXECUTE format('SELECT count(*) FROM public.%I', t) INTO n;
    IF n <> 0 THEN RAISE EXCEPTION 'PREFLIGHT FAIL: % has % rows - dropping would lose data', t, n; END IF;
  END LOOP;

  -- Only the 6 foreign keys that part B drops may point at / come from these tables
  SELECT count(*) INTO fk_outside
  FROM pg_constraint c
  WHERE c.contype = 'f'
    AND (c.conrelid::regclass::text IN ('specialty_test_sessions','specialty_tests','test_question_submissions','test_submissions')
      OR c.confrelid::regclass::text IN ('specialty_test_sessions','specialty_tests','test_question_submissions','test_submissions'))
    AND c.conname NOT IN (
      'specialty_test_sessions_providerSpecialtyId_fkey','specialty_test_sessions_userId_fkey','specialty_tests_specialtyId_fkey',
      'test_question_submissions_sessionId_fkey','test_submissions_providerSpecialtyId_fkey','test_submissions_testId_fkey');
  IF fk_outside <> 0 THEN RAISE EXCEPTION 'PREFLIGHT FAIL: % other foreign keys reference the legacy quiz tables', fk_outside; END IF;

  -- TestSessionStatus must be used only by the tables being dropped
  SELECT count(*) INTO n
  FROM pg_attribute a JOIN pg_class cl ON cl.oid = a.attrelid JOIN pg_type ty ON ty.oid = a.atttypid
  WHERE ty.typname = 'TestSessionStatus' AND a.attnum > 0 AND NOT a.attisdropped
    AND cl.relkind IN ('r','p','v','m','f')  -- real relations only; indexes also carry the column type
    AND cl.relname NOT IN ('specialty_test_sessions','specialty_tests','test_question_submissions','test_submissions');
  IF n <> 0 THEN RAISE EXCEPTION 'PREFLIGHT FAIL: TestSessionStatus is used by % other columns', n; END IF;

  -- No views depend on the tables
  SELECT count(*) INTO n FROM pg_depend d JOIN pg_rewrite r ON r.oid = d.objid JOIN pg_class v ON v.oid = r.ev_class
  WHERE d.refobjid IN (SELECT oid FROM pg_class WHERE relname IN ('specialty_test_sessions','specialty_tests','test_question_submissions','test_submissions')) AND v.relkind = 'v';
  IF n <> 0 THEN RAISE EXCEPTION 'PREFLIGHT FAIL: % views depend on the legacy quiz tables', n; END IF;

  RAISE NOTICE 'PREFLIGHT B OK (4 legacy tables empty, no outside references)';
END
$$;

ROLLBACK;
