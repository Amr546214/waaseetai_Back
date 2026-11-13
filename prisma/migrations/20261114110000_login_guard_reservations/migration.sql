BEGIN;
ALTER TABLE login_guard_state DROP CONSTRAINT IF EXISTS login_guard_state_scope_check;
ALTER TABLE login_guard_state ADD CONSTRAINT login_guard_state_scope_check CHECK (scope IN ('PAIR','IP','ACCOUNT'));
CREATE TABLE login_guard_attempts (
 id TEXT PRIMARY KEY,
 ip_key TEXT NOT NULL,
 pair_key TEXT,
 account_key TEXT,
 ip TEXT NOT NULL,
 hint TEXT,
 policy JSONB NOT NULL,
 created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 expires_at TIMESTAMPTZ NOT NULL DEFAULT now() + interval '2 minutes'
);
CREATE INDEX login_guard_attempts_ip ON login_guard_attempts(ip_key,expires_at);
CREATE INDEX login_guard_attempts_pair ON login_guard_attempts(pair_key,expires_at);
CREATE INDEX login_guard_attempts_account ON login_guard_attempts(account_key,expires_at);
CREATE INDEX login_guard_attempts_expiry ON login_guard_attempts(expires_at);
COMMIT;
