-- Rollback of 20261114100000_login_guard_state. Self-protecting: refuses while a block is still active (dropping the table would silently lift it).
DO $$
BEGIN
  IF to_regclass('public.login_guard_state') IS NULL THEN RETURN; END IF;
  IF EXISTS (SELECT 1 FROM "login_guard_state" WHERE "blocked_until" > now()) THEN
    RAISE EXCEPTION 'login_guard_state still holds active blocks; unblock or wait for them to expire before rolling back';
  END IF;
  DROP TABLE "login_guard_state";
END $$;
