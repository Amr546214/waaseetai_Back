BEGIN;
DO $$ BEGIN
 IF EXISTS(SELECT 1 FROM login_guard_attempts WHERE expires_at>now()) OR EXISTS(SELECT 1 FROM login_guard_state WHERE scope='ACCOUNT' AND blocked_until>now()) THEN RAISE EXCEPTION 'Active login protection exists; keep the additive schema during container rollback'; END IF;
END $$;
DROP TABLE login_guard_attempts;
DELETE FROM login_guard_state WHERE scope='ACCOUNT';
ALTER TABLE login_guard_state DROP CONSTRAINT login_guard_state_scope_check;
ALTER TABLE login_guard_state ADD CONSTRAINT login_guard_state_scope_check CHECK(scope IN('PAIR','IP'));
COMMIT;
