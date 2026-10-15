-- Rollback of 20261018060000_rate_limit_counter. Self-protecting: refuses while the table still holds live (unexpired) counters,
-- because dropping them would silently reset active lockouts. Wait for the windows to expire (or set RATE_LIMIT_STORE back to memory first).
DO $$
DECLARE live integer;
BEGIN
  IF to_regclass('public.rate_limit_counters') IS NULL THEN RETURN; END IF;
  EXECUTE 'SELECT count(*) FROM "rate_limit_counters" WHERE "reset_at" > now()' INTO live;
  IF live > 0 THEN
    RAISE EXCEPTION 'ROLLBACK REFUSED: % live rate-limit counter(s) would be dropped (active lockouts would reset)', live;
  END IF;
  EXECUTE 'DROP TABLE "rate_limit_counters"';
END $$;
