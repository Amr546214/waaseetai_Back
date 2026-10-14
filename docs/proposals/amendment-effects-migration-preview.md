# Amendment effective: migration preview, API contract, money rules

Status: CODE + TESTS ONLY. The migration below is **NOT EXECUTED** and needs owner approval. Nothing was run against any database.
Implements the "simplest variant" of `amendment-effects.md`: no pending-funding state; approval and funding are one transaction.

## 1. Migration `20261016100000_amendment_effective` (additive only)

Files: `prisma/migrations/20261016100000_amendment_effective/migration.sql` and `rollback.sql` (both headed `NOT EXECUTED`).

```sql
ALTER TABLE "project_amendments"
  ADD COLUMN IF NOT EXISTS "appliedAt" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "priceBefore" DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS "priceAfter" DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS "durationBefore" INTEGER,
  ADD COLUMN IF NOT EXISTS "durationAfter" INTEGER,
  ADD COLUMN IF NOT EXISTS "addedStageId" TEXT,
  ADD COLUMN IF NOT EXISTS "fundingAuthorizedAt" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "fundingAuthorizedAmount" DOUBLE PRECISION;
ALTER TABLE "project_stages" ADD COLUMN IF NOT EXISTS "amendmentId" TEXT;
CREATE TABLE IF NOT EXISTS "contract_terms_versions" (...);   -- id, contractId (FK, cascade), version, addendumText, amendmentId (unique), createdAt; unique (contractId, version)
```

* No enum change (`AmendmentStatus` is untouched: an applied amendment is `APPROVED` with `appliedAt` set), no change to `wallet_transactions` (its `type` is a string: `AMENDMENT_TOPUP`, `AMENDMENT_REFUND`).
* Effect on existing rows: every new column is NULL. Old `APPROVED` rows therefore stay "recorded only" (`appliedAt` NULL, `effect: RECORD_ONLY`) and are never re-applied (the claim only matches `PENDING_OTHER_PARTY`).
* Rollback (`rollback.sql`): drops the new table and columns. Safe only before any amendment was applied; afterwards the contract/escrow/stage changes remain and only the before/after audit values are lost.
* The code must NOT be deployed before this migration is applied (Prisma selects the new columns).

## 2. API contract

All money is USD. Errors are `{ success:false, message (Arabic), errors? }`.

| Call | Who (active role) | Body | Result |
| --- | --- | --- | --- |
| `POST /client/projects/:projectId/amendments` | client | `{type,title,description?,budgetDelta?,durationDeltaDays?}` (budget max 2 decimals) | 201 amendment, status `PENDING_OTHER_PARTY`, `effect:'PENDING'`; nothing changes |
| `POST /provider/projects/:projectId/amendments` | provider | same | same |
| `POST /client/projects/amendments/:id/payment-otp` | client (the contract's client) | none | 200 `{otpSentTo, expiresAt, amount}`; email code, 2 min, purpose `AMENDMENT_PAYMENT`, bound to this amendment id + amount. 400 no payment needed; 409 wallet short (`errors:[{required,available,shortfall}]`), dispute, legacy escrow, escrow not HELD; 403 not yours |
| `POST /client/projects/amendments/:id/authorize-funding` | client who RAISED a budget increase | `{otpCode}` | 200 amendment with `fundingAuthorized:true`. Charges nothing. 400 wrong/expired/other-amount code, 429 locked after 5 wrong guesses |
| `POST /client/projects/amendments/:id/respond` | client answering a PROVIDER request | `{decision:'approve'|'reject', otpCode?}` | `otpCode` is required only for approving a budget increase. 200 amendment (`effect:'APPLIED'` on approve) |
| `POST /provider/amendments/:id/respond` | provider answering a CLIENT request | `{decision}` | approve applies it; a client-raised increase must have `fundingAuthorized` first (409 otherwise) |
| `POST /client/projects/amendments/:id/cancel`, `POST /provider/amendments/:id/cancel` | the raiser | none | 200, status `CANCELLED`, funding authorization cleared; 409 if no longer pending |

Amendment payload additions: `effect` (`APPLIED` = changed the contract; `RECORD_ONLY` = legacy approved row; `PENDING` = will apply on approval; `NONE` = rejected/cancelled), `effectNote`, `appliedAt`, `priceBefore/After`, `durationBefore/After`, `addedStageId`, `needsClientPayment` (budget increase), `fundingAuthorized`.

Refusals (all 409, nothing changes, amendment stays PENDING): contract not ACTIVE; escrow not HELD; OPEN/UNDER_REVIEW dispute on the project (`amendment-dispute-guard.ts`); legacy escrow without fee-policy-v2 snapshot for any BUDGET part (decision D6 proposed behavior; duration/scope still apply); stage plan not adding up to the price; wallet short; price below released gross; no editable stage can absorb a decrease; duration below 1 day or below elapsed days; concurrent change (guarded updates match zero rows).

## 3. Money rules

| Case | Client wallet | Escrow.amount | Contract.price | Stages | Commission |
| --- | --- | --- | --- | --- | --- |
| Increase +d | guarded decrement `walletBalance >= d`; `AMENDMENT_TOPUP` -d, `referenceId = amendment id` (unique => one charge) | += d (guarded on the previous amount) | += d | new LAST stage `تعديل: <title>`, stepOrder max+1, PENDING, amount d, `amendmentId` set; existing stages untouched; percentages of unreleased stages re-split to total 100 (approved stages keep theirs) | snapshot rate kept; cumulative round2 method on release |
| Decrease -d | refund `AMENDMENT_REFUND` +d | -= d | -= d | taken from the LAST PENDING/IN_PROGRESS stages with no delivery, each keeping >= 0.01; SUBMITTED/REVISION/APPROVED never touched; refused if capacity is short or price < released gross | `platformCommissionAmount` only reflects released gross, so it is unchanged; later releases follow the cumulative method on the new price |
| Duration | none | none | none | `durationDays += delta`; the delta goes on the new stage (if any) or the last unreleased stage; negative deltas come from unreleased stages (each keeps >= 1 day); sum of stage days moves by exactly delta | none |
| Scope | none | none | none | none | none; `Contract.termsVersion + 1` and a `contract_terms_versions` row with the addendum text |
| MIXED | all parts or none (one transaction) | | | | |

Worked example (+5 on 20 USD, 12.75 %): stages 10/10/5, commission 1.28 / 1.27 / 0.64 = 3.19, provider net 21.81 (asserted in tests).

Locking: stage approval and amendment apply both lock the contract row first (an `updatedAt` touch guarded on ACTIVE), then stages/escrow. The final-stage release now uses the committed contract price read inside that lock.

## 4. Decisions assumed (for the owner)

1. Applied = `APPROVED` + `appliedAt` (no new enum value). `effect` is derived; it has four values (`APPLIED`, `RECORD_ONLY`, `PENDING`, `NONE`) instead of two so pending/rejected rows do not lie.
2. Client-raised increase: the client's OTP-authorized act is a separate step (`authorize-funding`) after creating the request; the provider cannot approve before it. The OTP is consumed at authorization; the wallet is checked and debited at the provider's approval (409 if short by then).
3. Provider-raised increase: the client's code is verified outside the transaction (wrong guesses are counted even if refused) and consumed inside it (a refused approval leaves the code valid until it expires).
4. Legacy (non-v2) escrow: BUDGET amendments refused (D6); duration/scope amendments still apply.
5. Decrease allocation: last unreleased, undelivered stages first; a stage is never reduced to zero.
6. New stage days = the positive duration delta of the same amendment, else 0; `sum(stage.days)` moves by exactly the delta (it is not forced to equal `durationDays` if it did not before).
7. Cancel by the raiser is available; no expiry job; no notification on cancel.
8. Amendment creation is not blocked by a dispute or a legacy escrow (only applying is), to keep creation unchanged.
9. Client amendment routes are now gated by `authorizeActiveRole(CLIENT_*)` (activeRole decides).

Not verified: real Postgres row-lock behavior (tests use an in-memory stand-in with serialized transactions and rollback), the e-mail delivery of the code, any DB migration.
