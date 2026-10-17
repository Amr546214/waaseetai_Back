# Project message context - migration + backfill preview (NOT EXECUTED)

Migration: `prisma/migrations/20261018040000_project_message_context/migration.sql` (rollback: `rollback.sql` in the same folder). Nothing here has been run on dev or prod.

## 1. Schema change (additive, idempotent)
- enum `ConversationKind` (`GENERAL`, `PROJECT`).
- `conversations.kind` NOT NULL DEFAULT `GENERAL`; `conversations.contract_id` nullable, UNIQUE, FK -> `contracts(id)` ON DELETE SET NULL; indexes `(client_id, kind)`, `(provider_id, kind)`.
- `messages.event_key` nullable, UNIQUE (deterministic key of a project event message); index `(conversation_id, created_at, id)`.
- The existing unique `(project_id, provider_id)` is untouched. No row is moved, rewritten or deleted: after the migration every old conversation is `GENERAL` with `contract_id` NULL, exactly where it is today.

## 2. Behaviour BEFORE any backfill (what the code does with old rows)
- General list (`GET /chat/conversations`) shows only `kind = GENERAL`: old rows keep showing there.
- A project's «الرسائل» tab uses, in order: the room with `contract_id = contract.id`; else the existing conversation of the same project + the contract's two parties (the old shared room, used as is, `legacyShared: true`, history intact); else it creates a PROJECT room (unique + upsert-style race handling).
- Forward only (optional): with env `PROJECT_ROOM_LINK_CONTRACTS_FROM=<ISO date>` the negotiation room of a contract CREATED at/after that instant is linked in place (same row, no message moved) on first use. Unset = never. Contracts older than the date are never touched by code.

## 3. Backfill plan (separate approval; not part of the migration)
Link rule - only an explicit reference, deterministic, no guessing: a conversation `c` is linked to contract `k` iff
`c.project_id = k.project_id AND c.client_id = k.client_id AND c.provider_id = k.provider_id AND c.contract_id IS NULL AND c.kind = 'GENERAL'`
(`contracts.project_id` is UNIQUE, so at most one contract matches; a conversation whose provider/client differs from the contract's is NOT linked). It relabels the SAME row; no message is moved, copied or deleted.

Preview (read-only):
```sql
SELECT c.id AS conversation_id, k.id AS contract_id, k.status, (SELECT count(*) FROM messages m WHERE m.conversation_id = c.id) AS messages
FROM conversations c JOIN contracts k ON k.project_id = c.project_id AND k.client_id = c.client_id AND k.provider_id = c.provider_id
WHERE c.contract_id IS NULL AND c.kind = 'GENERAL' ORDER BY c.created_at, c.id;
-- not linkable (reported, never touched): conversations with no matching contract (pre-contract negotiations) or whose parties differ from the contract's
SELECT c.id FROM conversations c LEFT JOIN contracts k ON k.project_id = c.project_id AND k.client_id = c.client_id AND k.provider_id = c.provider_id WHERE k.id IS NULL;
```
Apply (idempotent, one transaction):
```sql
BEGIN;
UPDATE conversations c SET kind = 'PROJECT', contract_id = k.id
FROM contracts k
WHERE c.contract_id IS NULL AND c.kind = 'GENERAL' AND k.project_id = c.project_id AND k.client_id = c.client_id AND k.provider_id = c.provider_id
  AND NOT EXISTS (SELECT 1 FROM conversations x WHERE x.contract_id = k.id);
-- check: row count equals the preview count
COMMIT;
```
Backfill rollback (self-protecting, only rows this backfill linked; the message rows are untouched either way):
```sql
UPDATE conversations SET kind = 'GENERAL', contract_id = NULL WHERE kind = 'PROJECT' AND contract_id IS NOT NULL;
```
(Run it only before any room was created natively by the new code; natively created rooms have no negotiation history and are distinguishable by having no message older than the contract.)
Effect: after the backfill those conversations leave the general list and live in the project tab; old general-list links to them redirect (`GET /chat/conversations/:id/context`, FE redirect) to `?tab=messages`.

## 4. Rollback of the migration
`rollback.sql` refuses (RAISE EXCEPTION, nothing changed) while any PROJECT conversation, contract-linked conversation or event message exists.
