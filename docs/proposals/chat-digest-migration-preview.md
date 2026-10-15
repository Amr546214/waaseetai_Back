# Chat notification coalescing + e-mail digest - migration preview (NOT EXECUTED)

Migration: `prisma/migrations/20261019020000_chat_digest/migration.sql` (rollback: `rollback.sql`, same folder). Not run on dev or prod; applied only to the isolated `qa_iso_db`.

## What it adds (additive, idempotent, no existing table or row touched)
- `chat_digest_state (user_id, conversation_id) PK, last_digest_at timestamptz(3)` + index `(user_id, last_digest_at)`: when the last digest of that recipient+conversation was claimed.
- `chat_digest_activation (id 'default' PK, enabled_at timestamptz(3))`: the first switch-on time; only later messages are ever mailed.

## Coalescing needs NO schema change
It uses the existing `notifications` table (metadata.conversationId / unreadCount) and a transaction-scoped advisory lock, so it works before this migration is applied. Only the digest needs the two tables; with `CHAT_DIGEST_EMAIL_ENABLED` unset (default) nothing reads them.

## Rollout order
1. Deploy BE (coalescing is live; digest off). 2. Apply the migration (team, on the server). 3. Set `CHAT_DIGEST_EMAIL_ENABLED=true` (optionally `CHAT_DIGEST_EMAIL_ENABLED_FROM=<ISO>`); the first tick stores the activation time. Switching the flag off stops mail immediately.

## Rollback
`rollback.sql` refuses while either table holds rows (it would reset the 15-minute memory / the activation time). Turn the flag off first; delete the rows deliberately only if intended.
