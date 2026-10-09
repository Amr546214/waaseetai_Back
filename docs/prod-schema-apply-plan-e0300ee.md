# G5.5 — plan to apply the prod schema diff (main `e0300ee`)  —  **NOT EXECUTED**

Status: **plan only.** No SQL was run, nothing was changed in prod, nothing was deployed or restarted.
All files here contain no credentials.

## 0. What this plan is based on (G5 findings)
* Prod DB (`waseetai_db`, Postgres 16, container `waseetai-backend-postgres-1`) is behind `e0300ee`. The diff was computed
  with `prisma migrate diff --from-config-datasource --to-schema prisma/schema.prisma --script` against a **restore of the G4 backup**
  (never against live prod).
* `_prisma_migrations` in prod has only **5** applied rows; the repo has **35** migrations (30 pending). `migrate deploy` is therefore **forbidden**
  (it would try to re-create objects that `db push` already created).
* Row counts measured on the restored copy (counts only): `commission_logs`=0, the four legacy quiz tables=0.
* Running today on the server: `waseetai-backend-prod` is **Exited**; `waseetai-backend-live-amr-candidate` (image built from `fda247d`, 2026-09-21)
  is **Up** on `127.0.0.1:15010`; its schema still contains the four legacy quiz models. It is unknown (not inspected) whether it uses `waseetai_db`.

## 1. Files
| file | content |
|---|---|
| `docs/prod-schema-diff-e0300ee.sql` | full reference diff, 6 banner-separated sections (103 statements) = Part A + Part B |
| `docs/prod-schema-diff-e0300ee-part-a-additive.sql` | sections 1–5: types, tables, columns, indexes, foreign keys (92 statements, **no DROP**) |
| `docs/prod-schema-diff-e0300ee-part-b-drops.sql` | section 6: DROPs (6 FKs, 4 tables, 1 enum) (11 statements) |
| `docs/prod-schema-preflight-a-e0300ee.sql` / `-b-` | read-only preflight checks (`BEGIN READ ONLY … ROLLBACK`, raise on failure) |

Static check done: Part A + Part B contain exactly the same 103 SQL statements (as a multiset) as Prisma's original output; only grouping and
`SET LOCAL lock_timeout/statement_timeout` were added. The preflight scripts have **not** been executed anywhere (not even on a copy) — see step 0.

## 2. The six sections
| # | section | content | risk |
|---|---|---|---|
| 1 | CREATE TYPE / ALTER TYPE | 11 new enums; `CommissionType`+`STAGE_RELEASE`; `WithdrawalStatus`+`PROCESSING`,`REVERSED` | low; `ADD VALUE` inside a transaction needs PG ≥ 12 (prod is 16); the new values are not used in the same transaction |
| 2 | CREATE TABLE | `special_offers`, `special_offer_redemptions`, `notification_preferences`, `support_tickets`, `support_ticket_messages`, `project_amendments`, `payout_attempts`, `paypal_webhook_events`, `paypal_payments`, `company_team_members` | none (new, empty) |
| 3 | ALTER TABLE ADD COLUMN | `users`(2), `projects`(1), `provider_profiles`(1), `withdrawals`(1), `coupons`(6), `affiliate_profiles`(`level` default 1 + `minimumPayoutAmount` default 300), `commission_logs`(6) | `commission_logs` adds 4 `NOT NULL` columns **without default** → only valid while the table is empty (preflight A). Others are nullable or have constant defaults (metadata-only on PG 16) |
| 4 | INDEXES | 36 (13 unique); the only unique index on an existing table is `commission_logs(affiliateId, referralId, type, sourceStageId)` | plain `CREATE INDEX` takes a brief SHARE lock; DB is ~67 MB so it is milliseconds |
| 5 | FOREIGN KEYS | 25 new | new tables are empty; `projects.assignedEmployeeId`, `coupons.*TeamMemberId` are NULL for all existing rows |
| 6 | DROPS | 6 FKs, 4 legacy quiz tables, enum `TestSessionStatus` | **destructive** (all four tables are empty now); deferred to Part B |

## 3. Why two parts
* **Part A is backward compatible** with an older backend (e.g. `fda247d`): all additions are new objects, nullable/defaulted columns or new enum values.
  The single exception is `commission_logs`: an old backend that INSERTs a commission row would now fail (new NOT NULL columns). The affiliate commission engine is
  disabled by flag in `e0300ee`; confirm the same for the running `fda247d` candidate before Part A.
* **Part B drops tables an old backend still maps.** Do it only after the new backend is verified and no running backend uses those tables.

## 4. Execution plan (each step stops the whole plan on failure; nothing here is run automatically)
Convention: a throwaway container on the prod docker network, credentials only through a `chmod 600` temp env file that is deleted afterwards, never printed
(same technique as the G4 backup). `NET=waseetai-backend_waseetai`, `HOST=postgres`, DB `waseetai_db`.

**Step 0 — rehearsal — DONE 2026-10-03 on an isolated copy, see §8**
Restore the newest backup into a throwaway tmpfs Postgres 16 (`--network none`), run preflight A, Part A, preflight B check, then
`prisma migrate diff` and confirm the remaining diff equals Part B. Proves the SQL applies cleanly end-to-end before touching prod.

**Step 1 — fresh backup (<= 15 min before Part A)**
Same procedure as G4: `pg_dump -Fc` via temp `postgres:16-alpine` to `/root/backups/waseetai-prod-db-<UTC>.dump` (700 dir / 600 file), sha256 file,
`pg_restore --list` and a throwaway restore. **Abort if** size is 0, checksum/TOC fails, or the restore fails.

**Step 2 — preflight A (read-only)**
`psql -v ON_ERROR_STOP=1 -f prod-schema-preflight-a-e0300ee.sql` from a temp container. It checks: PG ≥ 12; `commission_logs` = 0 rows;
none of the 10 new tables / 11 new enums / 18 new columns / 3 new enum values already exist (guards a half-applied earlier run);
all required tables exist; no idle-in-transaction session older than 5 min. Also verify at shell level: newest backup is < 15 min old, size > 0, checksum OK.
**Abort on any failure.**

**Step 3 — apply Part A in ONE transaction**
`psql --single-transaction -v ON_ERROR_STOP=1 -f prod-schema-diff-e0300ee-part-a-additive.sql` (file mounted read-only in the temp container).
Any error → the transaction is rolled back automatically; then verify nothing was created (re-run preflight A: it must still pass). Do not retry blindly.
`lock_timeout=10s` makes it fail instead of queueing behind a long-running query.

**Step 4 — verify the result with the diff tool (read-only)**
Run `prisma migrate diff --from-config-datasource --to-schema prisma/schema.prisma --script` from a tools container built from the `e0300ee` checkout
(`docker build --target development`, local build only, **not a deploy**) with a temp env file containing **only** `DATABASE_URL`.
Expected: the output contains exactly the 11 statements of Part B **plus the two known benign `active_attempt_unique` statements** (see §8) and nothing else. Any other statement → stop and investigate.

**Step 5 — record the already-reflected migrations (no `migrate deploy`)**
Only after step 4 matches. For each migration listed in §5 **except** `20260927120000_retire_legacy_specialty_quiz_models`:
```
npx prisma migrate resolve --applied <migration_name>      # one row written to _prisma_migrations per call; no schema SQL is executed
```
Loop (same tools container, same temp env file):
```
for m in \
  20260828150000_harden_contract_acceptance_workflow \
  20260828170000_add_real_project_stages_and_deliveries \
  20260828190000_secure_wallet_payment_idempotency \
  20260829200000_link_services_to_accreditation_samples \
  20260829203000_backfill_service_accreditation_links \
  20260829210000_publish_existing_market_models \
  20260829223000_marketplace_real_data \
  20260831090000_extend_client_request_details \
  20260901120000_add_cart_checkout \
  20260902100000_provider_coupons \
  20260902130000_add_disputes_withdrawals_ratings_onboarding \
  20260903120000_add_message_context \
  20260910120000_add_stage_rating \
  20260912120000_add_reviewer_role \
  20260915000000_add_newsletter_subscriber \
  20260916120000_phase3a_add_role_profile_display_fields \
  20260919120000_add_affiliate_banking_sensitive_field_types \
  20260919170000_add_marketer_name_sensitive_field_types \
  20260923160000_add_project_amendments \
  20260928120000_add_paypal_payments \
  20260929120000_add_company_team_member \
  20260929130000_extend_coupons_team_approval \
  20260929140000_add_special_offers \
  20260929150000_add_marketing_spend_cap \
  20260929160000_add_phone_otp_enabled \
  20260929170000_add_notification_preferences \
  20260929180000_add_support_tickets \
  20260930100000_add_affiliate_commission_fields \
  20261001120000_add_project_assigned_employee; do
  npx prisma migrate resolve --applied "$m" || break
done
```
Never run `prisma migrate deploy` or `db push`.

**Step 6 — start the candidate (separate approval, not part of G5.5)**
Candidate `e0300ee` with `RUN_DB_PUSH=false`, `RUN_DB_MIGRATIONS=false` (entrypoint only runs `prisma generate`). Smoke-test login and one read per area
(users, projects, withdrawals, coupons, provider profile) before any traffic.

**Step 7 — Part B (later, separate approval)**
Only when (a) the new backend is verified, (b) no running backend (check `waseetai-backend-live-amr-candidate`/`fda247d`) uses the legacy quiz tables.
Fresh backup → `prod-schema-preflight-b-e0300ee.sql` (tables still empty, no outside FK, enum used only by those tables, no views) →
`psql --single-transaction -v ON_ERROR_STOP=1 -f …-part-b-drops.sql` → re-run the diff: it must contain **only the two benign `active_attempt_unique` statements** (§8) →
`prisma migrate resolve --applied 20260927120000_retire_legacy_specialty_quiz_models`.

## 5. The 30 migrations needing `migrate resolve --applied` (35 in repo, 5 already applied)
 1. `20260828150000_harden_contract_acceptance_workflow`
 2. `20260828170000_add_real_project_stages_and_deliveries`
 3. `20260828190000_secure_wallet_payment_idempotency`
 4. `20260829200000_link_services_to_accreditation_samples`
 5. `20260829203000_backfill_service_accreditation_links`  ← data: UPDATE service_catalogs.accreditationSampleId (data backfill)
 6. `20260829210000_publish_existing_market_models`  ← data: UPDATE service_catalogs SET status=PUBLISHED for PENDING/UNDER_REVIEW/APPROVED models
 7. `20260829223000_marketplace_real_data`
 8. `20260831090000_extend_client_request_details`
 9. `20260901120000_add_cart_checkout`  ← data: INSERT of the WASEET10 seed coupon (ON CONFLICT DO NOTHING)
10. `20260902100000_provider_coupons`
11. `20260902130000_add_disputes_withdrawals_ratings_onboarding`
12. `20260903120000_add_message_context`
13. `20260910120000_add_stage_rating`
14. `20260912120000_add_reviewer_role`
15. `20260915000000_add_newsletter_subscriber`
16. `20260916120000_phase3a_add_role_profile_display_fields`
17. `20260919120000_add_affiliate_banking_sensitive_field_types`
18. `20260919170000_add_marketer_name_sensitive_field_types`
19. `20260923160000_add_project_amendments`
20. `20260927120000_retire_legacy_specialty_quiz_models`  ← **after Part B only**
21. `20260928120000_add_paypal_payments`
22. `20260929120000_add_company_team_member`
23. `20260929130000_extend_coupons_team_approval`
24. `20260929140000_add_special_offers`
25. `20260929150000_add_marketing_spend_cap`
26. `20260929160000_add_phone_otp_enabled`
27. `20260929170000_add_notification_preferences`
28. `20260929180000_add_support_tickets`
29. `20260930100000_add_affiliate_commission_fields`
30. `20261001120000_add_project_assigned_employee`

Already applied in prod (not in the list): `20260808143318_init_fresh_schema`, `20260819153500_add_accreditation_samples_and_update_enums`, `20260827193000_provider_profile_change_workflow`, `20260828093000_add_user_sessions`, `20260828113000_expand_unified_account_audit_log`.

`20260927120000_retire_legacy_specialty_quiz_models` is exactly the four `DROP TABLE` + `DROP TYPE` statements of Part B (verified in its migration.sql), which is why it is resolved only after Part B.

### ⚠ Three of them contain data statements that `resolve --applied` will SKIP
Marking a migration applied records it without running it. These three change data, not schema:
1. `20260829203000_backfill_service_accreditation_links` — `UPDATE service_catalogs.accreditationSampleId` backfill.
2. `20260829210000_publish_existing_market_models` — `UPDATE service_catalogs SET status='PUBLISHED'` for PENDING/UNDER_REVIEW/APPROVED models. **Do not run it blindly**: it would publish models awaiting review (the new AI audit is advisory only and never publishes).
3. `20260901120000_add_cart_checkout` — inserts the seed coupon `WASEET10`.
Decide per item whether prod needs the data effect (check on the Step-0 copy / the backup) *before* resolving; skipping is the safe default for #2.

## 6. Rollback / abort
* Before Step 3 commits: any failure rolls back automatically; the database is unchanged. Abort criteria: failed preflight, stale or unverified backup, unexpected diff, any non-zero exit.
* After Step 3 commits: Part A is additive, so the safe default is to keep it and fix forward. If a restore is required: stop the writers, create a new database, `pg_restore` the Step-1 backup into it, repoint the application, keep the damaged DB for analysis. Data written after the backup is lost, so keep the window short.
* Step 5 can be reversed per row (`prisma migrate resolve --rolled-back <name>`), it never changes schema.
* Part B is irreversible without the backup; hence its own backup and preflight.

## 7. Not done / still unknown
* No SQL executed (including rehearsal). Preflight scripts and Part A/B untested by execution (static equivalence only).
* Which database `waseetai-backend-live-amr-candidate` uses; whether its affiliate engine is disabled.
* Whether the `fda247d` image still serves traffic that touches the legacy quiz tables.

## 8. Rehearsal result (Step 0) — executed on an isolated restore only, never on prod
Setup: throwaway `postgres:16-alpine` with `--network none`, tmpfs data dir, backup `waseetai-prod-db-20261002-223032Z.dump` restored into it.
Prod was not contacted (no connection, no `docker exec` into prod containers). Prisma could not reach a network-less container, so schema-only dumps (DDL, 0 data
lines) were loaded into a local throwaway Postgres and `prisma migrate diff` (schema `e0300ee`) was run there.

| check | result |
|---|---|
| restore of the backup | rc 0, 70 tables |
| preflight A | PASS (`server 16.15, commission_logs empty, no target objects exist`) |
| Part A in one `--single-transaction` | rc 0, **no WARNING/ERROR/NOTICE output**, 70 → 80 tables |
| pipeline sanity: diff of the *pre* dump | identical (103 statements) to the G5 diff |
| diff after Part A | the 11 Part B statements **+ 2 benign statements** (below); nothing else |
| preflight A run again | fails as designed (`tables already exist: …`) |
| Part A re-applied | fails at the first statement (`type "ApprovalStatus" already exists`); schema afterwards **identical** to before → rollback works |
| preflight B | PASS after a bug fix (below) |
| Part B (**isolated copy only**) | rc 0, 80 → 76 tables |
| diff after Part B | only the 2 benign statements |

Bug found and fixed by the rehearsal: preflight B first FAILED ("TestSessionStatus used by 1 other columns") because index entries in `pg_class` also carry the column
type; the check now counts real relations only (`relkind IN ('r','p','v','m','f')`). Part B itself was unaffected.

### The two benign statements (permanent noise, not a schema difference)
```
DROP INDEX "active_attempt_unique";
CREATE UNIQUE INDEX "active_attempt_unique" ON "payout_attempts"("withdrawalId") WHERE (status IN ('PENDING','PROCESSING'));
```
`schema.prisma` declares this partial unique index with `where: raw("status IN (…)")`; PostgreSQL stores it normalised as `status = ANY (ARRAY[…::"PayoutAttemptStatus"])`,
so Prisma always thinks it differs. Verified independent of this plan: a brand-new empty database created with `prisma db push` from the same schema shows the same two statements.
Never apply them; the index in the database is correct.

Not covered by the rehearsal: Step 5 (`migrate resolve`), the data-bearing migrations of §5, application behaviour on the new schema, and lock/timing behaviour under live traffic.
