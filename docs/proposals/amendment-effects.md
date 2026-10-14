# Proposal: making an approved amendment effective

Status: PROPOSAL ONLY. No code, no migration. Everything below needs a product and a financial decision from the owner before any implementation. All amounts are USD.

## 1. Current behavior (what is true today)

- A `ProjectAmendment` (types SCOPE, BUDGET, DURATION, MIXED; `budgetDelta` Float, `durationDeltaDays` Int) is raised by the client or the provider and answered by the other party.
- Approving or rejecting only sets `status` (APPROVED / REJECTED) and `respondedAt` (`src/services/project-amendment.service.ts`, `respondToAmendment`, `respondToAmendmentAsProvider`). It never changes `Contract.price`, `Contract.durationDays`, `Escrow.amount`, or any `ProjectStage`.
- Since this PR the API says so: every amendment carries `effect: 'RECORD_ONLY'` and `effectNote`, and the notifications say the decision is recorded only.

## 2. Goal

An APPROVED amendment changes the real contract, the money held for it and the stages, atomically, with a full audit trail, and never leaves the three (contract, escrow, stages) disagreeing.

## 3. Who must confirm

| Type | Raised by | Confirms | Extra condition |
| --- | --- | --- | --- |
| BUDGET increase | either | the other party | the client's wallet must cover the delta at the moment of confirmation (the client's confirmation is the payment authorization) |
| BUDGET decrease | either | the other party | only on the part not yet released; never below what is already released (gross) |
| DURATION | either | the other party | none financial |
| SCOPE | either | the other party | text addendum only |
| MIXED | either | the other party | all parts apply together or none |

Rule: the party who did NOT raise it confirms; if the client raised a budget increase, the client's act of raising is the funding intent and the provider confirms; if the provider raised it, the client confirms and pays at confirmation. Funding always happens in the same database transaction as the state change.

## 4. State machine

Current: `PENDING_OTHER_PARTY -> APPROVED | REJECTED | CANCELLED`.

Proposed:

```
PENDING_OTHER_PARTY --reject--> REJECTED
PENDING_OTHER_PARTY --cancel (by raiser)--> CANCELLED
PENDING_OTHER_PARTY --expire (e.g. 7 days)--> EXPIRED
PENDING_OTHER_PARTY --approve--> APPROVED_PENDING_FUNDING   (budget increase, client must pay)
PENDING_OTHER_PARTY --approve--> APPLIED                    (no money needed, or funding done in the same transaction)
APPROVED_PENDING_FUNDING --funded--> APPLIED
APPROVED_PENDING_FUNDING --funding window ends / client cancels--> LAPSED   (nothing changed)
```

Simplest variant (recommended): no APPROVED_PENDING_FUNDING. Approval of a budget increase is refused (409, clear message) unless the wallet can pay the delta right then; the approval and the top-up happen in one transaction. APPLIED replaces APPROVED as the effective terminal state; the old APPROVED rows stay as "recorded only" history.

Only one non-terminal amendment per contract that touches money or duration at a time (the existing "one pending client request per contract" rule is extended to both sides).

Allowed only while the contract is ACTIVE and there is no OPEN/UNDER_REVIEW dispute (see `dispute-policy-current-vs-proposed.md`).

## 5. Budget increase (delta > 0)

Example used below: contract 20 USD, two stages 10 + 10, provider level 1 = 12.75% commission, amendment +5 USD.

Steps, all in one transaction:

1. Lock contract and escrow rows. Re-check ACTIVE, escrow HELD, no dispute, amendment still pending.
2. Debit the client wallet by the delta (`User.walletBalance` guarded decrement, same pattern as `confirmPayment`); insert a `WalletTransaction` (type `AMENDMENT_TOPUP`, amount -5, referenceId = amendment id). Insufficient balance: refuse, nothing changes; the UI offers deposit.
3. `Escrow.amount += 5`; `Contract.price += 5`. Insert an escrow adjustment audit row (see section 9).
4. Stages (decision needed, see options):
   - Option S1 (recommended): add a new last stage "تعديل: <title>" worth the delta, status PENDING, `stepOrder = max + 1`, `days = durationDelta or 0`. Existing stages are untouched, which is safe when some are already APPROVED.
   - Option S2: add the delta to the current (first unreleased) stage amount. Simple, but changes a stage the provider may already be working on.
   - Option S3: re-split the unreleased remainder proportionally. Most complex, risks cent drift, changes amounts the provider already saw.
5. Commission on the delta: no new snapshot. The escrow keeps `providerCommissionRateSnapshot` (12.75). Commission is computed on the cumulative gross exactly as today (`splitRelease`, `round2(total x rate)`), so the delta commission appears when its stage is released. Open decision D2: use the escrow snapshot rate (recommended, one contract = one rate) or the provider's CURRENT level rate (the provider may have leveled up since signing).
6. Invoices and audit: provider and client invoice rows are derived from stage deliveries, so the new stage produces its own invoice automatically. Add an audit record (admin audit + account log) for the amendment application with before/after price and escrow.

### Worked example A: contract 20 + 5 amendment, nothing released yet

| | Before | After (S1) |
| --- | --- | --- |
| Contract price | 20.00 | 25.00 |
| Escrow amount | 20.00 | 25.00 |
| Client wallet | W | W - 5.00 |
| Stages | 10.00 / 10.00 | 10.00 / 10.00 / 5.00 |
| Total commission 12.75% | round2(20 x 0.1275) = 2.55 | round2(25 x 0.1275 = 3.1875) = 3.19 |
| Provider net total | 17.45 | 21.81 |

Per stage on release (cumulative method): stage 1 commission 1.28, net 8.72; stage 2 commission 1.27, net 8.73; stage 3 commission 0.64, net 4.36. Net sum 8.72 + 8.73 + 4.36 = 21.81. Commission sum 1.28 + 1.27 + 0.64 = 3.19.

### Worked example B: stage 1 already released

Stage 1 released before the amendment: gross 10.00, commission 1.28, net 8.72 (already in the provider balance, untouched). After the +5: escrow 25.00, released 10.00, held 15.00; remaining stages 10.00 and 5.00 (S1) release with commissions 1.27 and 0.64. Option S2 would make stage 2 worth 15.00: cumulative 25 -> 3.19, so stage 2 commission is 3.19 - 1.28 = 1.91, net 13.09. Either way the total is exactly 25.00 gross, 3.19 commission, 21.81 net.

### Worked example C: top-up with commission on a different rate

If the provider is now level 2 and the owner chooses "current level rate" for the delta only, the escrow would need two rates; this breaks the single-snapshot model (`Escrow.providerCommissionRateSnapshot`) and `splitRelease`. That is why section 5 step 5 recommends the snapshot rate.

## 6. Budget decrease (delta < 0)

- Allowed only if `price + delta >= releasedAmount` (never claw back released money) and the remaining unreleased stages can absorb it (otherwise the amendment must also say which stage shrinks).
- Refund = |delta| back to the client wallet in the same transaction (`WalletTransaction` type `AMENDMENT_REFUND`), `Escrow.amount -= |delta|`, `Contract.price -= |delta|`, reduce or remove unreleased stage amounts.
- Example: 20 USD contract, stage 1 released (10.00), amendment -4 on stage 2: price 16.00, escrow 16.00, client refunded 4.00, stage 2 = 6.00, total commission round2(16 x 0.1275 = 2.04) = 2.04, so stage 2 commission 2.04 - 1.28 = 0.76, net 5.24; provider total net 8.72 + 5.24 = 13.96 = 16.00 - 2.04.
- A decrease requested by the client against stages already delivered but not yet approved is a dispute topic, not an amendment (open decision D5).

## 7. Duration change

- `Contract.durationDays += durationDeltaDays` (must stay >= 1 and >= elapsed days if the delta is negative).
- Stage `days`: put the delta on the current unreleased stage (or the new stage), so `sum(stage.days)` stays consistent with `durationDays`. Decision D4: validate that the invariant holds.
- There is no stored end date: the UI computes `daysLeft` from `signedAt + durationDays` (`provider.controller.getActiveProjects`), so changing `durationDays` is sufficient. Late flags follow automatically.
- No money impact, no wallet check.

## 8. Scope change

- Text-only addendum. Never changes money or days by itself (a scope change that costs more is a MIXED amendment).
- Versioned terms: keep `Contract.termsVersion` (exists, default 1) and append the addendum to a new `ContractTermsVersion` row; both parties' agreement is the approval. The latest version is what the contract page and the dispute view show.

## 9. Database changes (a MIGRATION IS REQUIRED; none is created here)

| Table | Change |
| --- | --- |
| `project_amendments` | new enum values on `AmendmentStatus`: `APPLIED`, `EXPIRED` (and `LAPSED` only if the pending-funding variant is chosen); new columns `appliedAt`, `appliedById`, `priceBefore`, `priceAfter`, `durationBefore`, `durationAfter`, `expiresAt`, `escrowAdjustmentId` |
| `escrow_adjustments` (new) | `id`, `escrowId`, `amendmentId` (unique), `delta`, `amountBefore`, `amountAfter`, `walletTransactionId`, `createdAt` |
| `contract_terms_versions` (new) | `id`, `contractId`, `version`, `addendumText`, `amendmentId`, `createdAt` |
| `project_stages` | optional `amendmentId` (which amendment created the stage) |
| `wallet_transactions.type` | new string values `AMENDMENT_TOPUP`, `AMENDMENT_REFUND` (the column is a string; no enum change) |
| `contracts` | no new column required (`price`, `durationDays`, `termsVersion`, `phasesCount` already exist; `phasesCount` must be updated when a stage is added) |

Application changes: a single `applyAmendment(tx, amendment)` function used by both respond paths; extend the existing atomic conditional `updateMany` guard so a double approve can never double-charge; update `Contract.phasesCount`; recompute nothing in `Escrow` snapshot fields.

## 10. Rollback and refusal rules

- Everything in one transaction: any failure (wallet short, contract no longer ACTIVE, dispute opened meanwhile, escrow not HELD) aborts and the amendment stays PENDING with a clear 409 message.
- A BUDGET amendment is refused when: the contract is not ACTIVE; the escrow is not HELD; an OPEN/UNDER_REVIEW dispute exists; the delta would take the price below the released gross; the client's wallet cannot cover an increase.
- Already COMPLETED stages are never edited. Their amounts, commissions and invoices stay as they were.
- No automatic undo of an APPLIED amendment. A reversal is a new amendment in the opposite direction (subject to the same rules), keeping the history append-only.

## 11. Risks

- Money correctness: the cumulative commission method makes the total exact (`round2(total x rate)`), but any partial re-split must be tested for cent drift (see the 1.28 / 1.27 / 0.64 example).
- Concurrency with stage approval: approving a stage releases escrow; both must lock the same contract row, otherwise an amendment could apply between "stage approved" and "escrow released".
- Concurrency with withdrawals: the provider's withdrawable balance is derived from released net, so an amendment never touches it directly.
- Trust: the provider could request a budget increase mid-delivery as leverage; the client must be able to refuse safely (REJECTED changes nothing, as today).
- Currency: everything is USD-only; there is no FX anywhere in this flow.
- Legacy (non-v2) escrows have no snapshot and no commission. Amendments on those must either be blocked or follow the legacy gross rule (decision D6).

## 12. Open decisions for the owner

- D1: Is a budget increase paid from the client's wallet at approval (recommended), or can it be left unpaid until later (adds APPROVED_PENDING_FUNDING)?
- D2: Commission on the delta: the escrow snapshot rate (recommended) or the provider's current level rate?
- D3: Where does the extra money go: a new last stage (S1, recommended), the current stage (S2) or a proportional re-split (S3)?
- D4: Must `sum(stage.days)` always equal `durationDays` after a duration change?
- D5: Are budget decreases allowed at all, and who may request one?
- D6: What to do with legacy (pre-fee-policy-v2) escrows: block amendments or apply gross?
- D7: Amendment expiry (days) and whether either side can cancel after the other approved but before funding.
- D8: Should an APPLIED amendment notify with money amounts and send an email/receipt, and does the invoice show the amendment as its own line?
- D9: Is platform admin allowed to apply or reverse an amendment manually (support case)?
