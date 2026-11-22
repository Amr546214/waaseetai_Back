-- NOT EXECUTED by the release process. Apply by hand on the server (psql / the team's migration procedure); no db push, no reset.
-- exam_ticket_uses was created with CHECK (scope = 'SETUP_TEST'). The modern SEB handshake (seb-js-proof.ts) records its single-use challenge with scope 'SEB_JS_CHALLENGE',
-- so every INSERT is refused (23514) and the exchange fails closed. Additive: widens the allowed scopes; existing rows are untouched.
BEGIN;
ALTER TABLE "exam_ticket_uses" DROP CONSTRAINT IF EXISTS "exam_ticket_uses_scope_check";
ALTER TABLE "exam_ticket_uses" ADD CONSTRAINT "exam_ticket_uses_scope_check" CHECK ("scope" IN ('SETUP_TEST', 'SEB_JS_CHALLENGE'));
COMMIT;
