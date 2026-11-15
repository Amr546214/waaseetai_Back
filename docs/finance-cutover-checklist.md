# Finance cutover checklist (official site) — NOT EXECUTED

Prepared 2026-11-15 from the state of **dev** (everything below is live and proven on dev). Nothing here has been run on the official server; the team applies it, in this order, with a backup first.

## 1. Environment (backend container)

| Variable | Value | Why |
|---|---|---|
| `CASHBACK_ENGINE_ENABLED` | `true` | client cashback on delivery completion |
| `CASHBACK_WALLET_TIMING` | `IMMEDIATE` | credit as soon as the score + a real rating exist |
| `AFFILIATE_COMMISSION_ENGINE_ENABLED` | `true` | marketer commission at stage release (client referrals only) |
| `PAYOUT_AUTOMATION_ENABLED` | owner decision | PayPal payouts; the marketer payout sends the NET after the withdrawal fee |
| `RUN_DB_MIGRATIONS` / `RUN_DB_PUSH` | `false` | migrations are applied by hand, never by the container |
| `FRONTEND_URL` | the official site address | mail links take their host from it |

Never copy `SETUP_TEST_DEV_FALLBACK` (dev only).

## 2. Migrations (additive, in this order; compare with the official schema first using `docs/prod-schema-diff-*`)

1. `20261011130000_finance_wiring_phase1` — fee snapshot on escrow (no 13% to the client)
2. `20261027120000_fee_policy_versions`
3. `20261113100000_closure_events_cashback` — cashback ledger + review tables
4. the affiliate commission columns (`commission_logs`: referredUserId, sourceProjectId, sourceStageId, baseAmount, appliedPercentage, level; enum `CommissionType.STAGE_RELEASE`; the unique index) — the adapted file used on dev, because `affiliate_profiles.level` already exists
5. `20261117100000_withdrawal_source` — separate provider / marketer ledgers
6. `20261118100000_marketer_withdrawal_fee` — `withdrawals.feePercent / feeAmount / netAmount` (nullable; NULL = no fee)

Each: `pg_dump` backup → `psql --single-transaction -v ON_ERROR_STOP=1 -f migration.sql`. All are additive (rollback = leave the columns, redeploy the previous image).

## 3. Rules the code enforces (what to verify after the switch)

- Minimum withdrawal 10 USD for every role, no maximum other than the balance.
- Provider and marketer ledgers are independent (`withdrawals.source`).
- Marketer withdrawal: the ledger is debited the **gross** amount; PayPal is paid the **net** (PayPal fee percent of the policy in force, snapshotted on the row).
- Cashback needs: project completed by delivery (never an administrative or mutual closure) + the audited payment score (admin, `/admin/operations/cashback/:id/score`) + a real provider rating. Until all three exist the entitlement stays pending.
- Dispute or open cancellation request freezes delivery, review, approval and revision for both sides (423).

## 4. Smoke after the switch (with an owner-approved marker, then clean up)

1. A referred client's stage release → commission row at level 1; a referred provider → none.
2. A completed project with score + rating → one `client_cashback_entries` row and one `CASHBACK` wallet transaction (no duplicate on replay).
3. A marketer withdrawal of 100 USD → row `amount=100, feePercent=7.75, feeAmount=7.75, netAmount=92.25`; the payout is 92.25.
4. A provider withdrawal → no fee fields.
