# Admin operations rollout — 2026-11-13

This change requires **both** frontend and backend. Deploying the frontend alone leaves the new pages without their APIs.

## Approved cashback policy

- Formula/rates remain the XLSX K39–K43 policy, including level 13 = 4.6%.
- K38 is an explicitly recorded, audited payment score from 0 to 100 for each completed contract. A Super Admin enters the score and its reason/reference.
- A client without a real provider rating retains a pending entitlement. No rating is invented; a real rating resumes processing, with a periodic worker as recovery.
- Credit the wallet immediately once inputs exist. Preserve the pre-completion level/rate and released-value snapshot. The actual rating at credit time may include the newly received project review.
- Administrative closures and consensual cancellations remain ineligible. No retrospective entitlement scan or backfill runs.
- Explicitly configure **CASHBACK_ENGINE_ENABLED=true** and **CASHBACK_WALLET_TIMING=IMMEDIATE** in the persistent backend deployment configuration and recreated container. These are approved deployment values, not new product decisions. Without them the page reports the configuration gate, and no new entitlement is created while disabled.

## Database deployment

New additive migration: `20261113120000_admin_operations` (expenses, content pages, broadcasts/deliveries, cashback reviews). Generate the Prisma client when building the backend. Apply this migration **before** starting the new backend.

Take a verified database backup first. Dev previously had a schema/migration-history mismatch: inspect the actual tables and `_prisma_migrations` before choosing the existing deployment method. Do not reset the database, use `db push`, blindly replay old migrations, or mark unapplied SQL as applied. Preserve the four migrations already deployed in earlier rounds.

The migration was exercised on an isolated Postgres baseline generated from the immediately preceding Prisma schema, followed by the new migration. This is **not** a claim that the historical migration chain builds from zero.

Container rollback preserves the additive tables and all operational/financial records. `rollback.sql` refuses table removal once operational records exist. Turning the engine off never reverses a credit that already happened.

## Implemented behavior

- Finance: positive USD expenses with an idempotency key, immutable records, version-checked void with reason, and atomic audit. No wallet debit accompanies a manual bookkeeping record.
- Operating result is cumulative: recognized escrow platform commission minus approved/paid affiliate commissions (counted once), credited cashback and recorded operating expenses. Deposits, held escrow, provider funds and depositor-borne payment fees are excluded. External costs must be entered; they are not guessed. Non-USD affiliate amounts are displayed separately and block a misleading USD net total.
- PDF/CSV reports show the cumulative definition and the exact loaded expense-page scope.
- Future billing is a read projection of **undelivered stages on active contracts**. Actual stage amount, actual start + duration when available. It does not charge a card, issue tax invoices, invent a payment gateway, or label a forecast as paid.
- CMS: server drafts, explicit publish/unpublish, version conflict protection and audit. Public API exposes only published fields; rendering is escaped plain text. Terms/privacy also update their existing platform settings. About, how-it-works, FAQ, contact copy and the home welcome message consume published server content. Existing defaults and the contact form remain available.
- Broadcast: in-app only, drafts, real audience count, explicit confirmation, frozen recipient snapshot, cancellation of the remainder, and durable batch delivery. Exactly one stored notification per campaign/user; delivered means stored in inbox, not read. Socket hints are best-effort. No email/WhatsApp campaign is implied. No campaign is sent by deployment.
- Team: leadership/Super Admin accounts are listed separately from ordinary staff. They are not editable as ordinary staff and cannot acquire a limited staff role through these routes.

## Minimal deployment handoff

Preserve all currently published dev-only Google/identity/wallet work when integrating latest main. Deploy both containers with rollback tags, apply the additive migration, configure the approved cashback flags, and check health plus logs for missing-table/worker errors. No live broadcast, financial test transaction, backfill, OTP bypass or production deployment is part of this rollout.
