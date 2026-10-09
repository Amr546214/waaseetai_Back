# prod-client-paypal-column-alter

> ## ✅ EXECUTED — 2026-10-04 22:26–22:28 UTC
> Executed on prod after an explicit go-ahead. Only the single `ALTER TABLE` below was run. Results are in §9.
> No backend/frontend deploy, no `migrate deploy`, no `db push`, no migration-history change, no `DROP`, `provider_profiles` untouched.

## Why
`ClientProfile.paypalPayoutEmail` (backend PR #13) exists in `prisma/schema.prisma` but the column was never added to the **prod** database.
Effect on prod today: every Prisma read of `client_profiles` that selects all columns fails with
`The column client_profiles.paypalPayoutEmail does not exist in the current database`
(this was the real cause of `POST /api/user/add-account-type` → 500, and is the likely cause of the earlier `PUT /api/profiles/update` 500s for client accounts).
Backend PR #16 (`2d0ee99`, already on prod) makes add-account and switch-active-role tolerant, but other client-profile reads and the client PayPal feature still need the column.

## 1. Scope
- **prod DB only** (`waseetai_db`, Postgres 16, container `waseetai-backend-postgres-1`).
- No backend deploy. No frontend deploy.
- No `prisma migrate deploy`, no `prisma db push`, no change to the migration history (`_prisma_migrations`).
- Exactly one statement: add one nullable column.

Convention (same as `prod-schema-apply-plan-e0300ee.md`): a throwaway `postgres:16-alpine` container on the prod docker network
(`NET=waseetai-backend_waseetai`, `HOST=postgres`, DB `waseetai_db`); credentials only through a `chmod 600` temp env file that is deleted afterwards and never printed.

## 2. Pre-check (read-only)
```sql
SELECT column_name, data_type, is_nullable
FROM information_schema.columns
WHERE table_name = 'client_profiles'
  AND column_name = 'paypalPayoutEmail';
```
Expected **before**: `0 rows`.
- 1 row (`paypalPayoutEmail | text | YES`) → already applied: **stop**, nothing to do (the SQL below is idempotent, but there is nothing to change).
- A row with another type → **stop** and report.

Also confirm the table exists and look for stuck sessions that could make the ALTER wait:
```sql
SELECT to_regclass('public.client_profiles');
SELECT pid, state, now() - xact_start AS age FROM pg_stat_activity
WHERE datname = 'waseetai_db' AND state = 'idle in transaction' AND now() - xact_start > interval '5 minutes';
```
Expected: `client_profiles` found; 0 stuck sessions. Otherwise stop.

## 3. Backup (before any ALTER)
`pg_dump -Fc` of the prod DB with the throwaway container, to a new file:
```
/root/backups/waseetai-prod-db-<UTC yyyymmdd-HHMMSSZ>.dump      (directory 700, file 600)
/root/backups/waseetai-prod-db-<UTC yyyymmdd-HHMMSSZ>.dump.sha256
```
Then verify:
- size > 0 (`stat -c %s`),
- `sha256sum` written to the `.sha256` file and re-checked with `sha256sum -c`,
- `pg_restore --list <file> | head` shows a TOC (and `client_profiles` is in it).

Record here when it is taken (leave blank until executed):
| file | size (bytes) | sha256 |
|---|---|---|
| | | |

Abort if the size is 0, the checksum fails or the TOC is unreadable. Take the backup ≤ 15 minutes before the ALTER.

## 4. SQL
```sql
BEGIN;
SET LOCAL lock_timeout = '5s';
ALTER TABLE "client_profiles"
ADD COLUMN IF NOT EXISTS "paypalPayoutEmail" TEXT;
COMMIT;
```
Run with `psql -v ON_ERROR_STOP=1 -f <file>`. If the lock cannot be taken in 5 s the statement fails and the transaction rolls back with no change; wait and retry — do not raise the timeout without a new decision.
Adding a nullable column without a default is a metadata-only change in Postgres 11+ (no table rewrite).

## 5. Post-check (read-only)
Run the same query as the pre-check.
Expected: exactly one row
```
paypalPayoutEmail | text | YES
```
Anything else → report and stop (see §7).

## 6. Health and log checks (after the ALTER)
1. `https://waseetai.com/api/health` → `200`.
2. `docker logs --since 5m waseetai-backend-prod-candidate-e0300ee` → **zero 5xx** (`" 5xx ` / `StatusCode:: 5`); also no `does not exist in the current database`.
3. Watch specifically:
   - `POST /api/user/add-account-type`
   - `PUT /api/profiles/update` (a `400` for invalid data is the expected success; a new `500` → collect that log line only, no secrets, and stop for review)
   - also `PUT /api/profiles/update/banking` (client PayPal) and `POST /api/user/switch-active-role`.
4. Frontend prod container: zero 5xx in the same window.

No backend/frontend restart is needed: Prisma simply starts finding the column.

## 7. Rollback note
- The column is **nullable and additive**; nothing reads it as required. Rolling back normally needs **no `DROP`**: leave the column in place (the previous backend images ignore it).
- Do **not** `DROP COLUMN` without a separate approval (it would re-break every full-select read of `client_profiles` from the current code).
- If the ALTER itself fails: the transaction rolled back, state is unchanged; fix the cause (lock wait / permissions) and re-run.
- If something unexpected appears afterwards, the backup from §3 is the recovery point; restoring it is a separate decision, not part of this runbook.

## 8. Related, not done here
- Other schema drift on prod (see `prod-schema-apply-plan-e0300ee.md`, Part A additive / Part B drops) is a separate plan with its own gates.
- This runbook does not touch `provider_profiles` (its `paypalPayoutEmail` column is outside this step; verify it with the same pre-check query if needed).

## 9. Execution results (2026-10-04, UTC)
| step | result |
|---|---|
| pre-check (column) | **0 rows** (column absent) |
| table / sessions / version | `client_profiles` exists; 0 idle-in-transaction sessions > 5 min; PostgreSQL 16.15, DB `waseetai_db`, host `postgres` |
| backup file | `/root/backups/waseetai-prod-db-20261004-222611Z.dump` (file 600, dir 700) |
| backup size | 345,406 bytes |
| backup sha256 | `5b065ed4df2ab8f943b96713cbcde93118f69c674153c2cfd1b4692015af9a3b` (`sha256sum -c` OK, `.sha256` file alongside) |
| `pg_restore --list` | OK: 80 table-data entries, `client_profiles` present |
| SQL output | `BEGIN` / `SET` / `ALTER TABLE` / `COMMIT` (exit 0, lock_timeout not hit) |
| post-check | `paypalPayoutEmail \| text \| YES` (one row) |
| `/api/health` | `200` — `{"success":true,"status":"ok","service":"waseetai-backend"}` |
| backend prod 5xx (5 min) | **0** (and 0 `does not exist in the current database` errors) |
| frontend prod 5xx (5 min) | **0** |
| nginx 5xx after the ALTER | **0** |
| watched endpoints | no request to `add-account-type`, `profiles/update`, `profiles/update/banking` or `switch-active-role` yet (nothing to judge) |

No backend restart was needed; Prisma finds the column on the next query. The backup is the recovery point; no `DROP` was or will be run without separate approval.
