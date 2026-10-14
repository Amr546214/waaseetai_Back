# Dispute freeze and dispute resolution (implemented policy)

Status: CODE AND TESTS ONLY. Nothing here was deployed or run against any database. **No migration is needed**: the freeze is derived from the existing `Dispute.status`, and the financial path uses existing columns/tables (`Escrow`, `WalletTransaction`, `AccountAuditLog`). See "Schema" at the end.

Owner-chosen policy: while a dispute on a project is OPEN / UNDER_REVIEW, communication, evidence and delivery stay allowed; stage approval and every financial release of that project are frozen until the dispute is decided.

## 1. Policy table

| Action while the project has an OPEN/UNDER_REVIEW dispute | Allowed? | Enforced by |
| --- | --- | --- |
| Chat messages | yes | not gated (static test) |
| Evidence upload / dispute details | yes | not gated |
| Provider uploads delivery files, submits a delivery | yes | `assertDeliverable`/`submitDelivery` do not consult the freeze (static test) |
| Client requests a REVISION | yes (assumption A1) | revision is not an approval and moves no money |
| Client APPROVES a stage (intermediate or final) | **no, 423** `PROJECT_FROZEN_BY_DISPUTE` | `reviewDelivery`: contract row lock then dispute check, inside the release transaction |
| Escrow release / project completion / completion points | **no** | same transaction; nothing is written when the check fails |
| Provider withdraws earnings released BEFORE the dispute | yes | not project-scoped; no wallet-wide freeze |
| Admin text closure (MUTUAL_CLOSE, "no financial change") | yes, moves no money | `POST /api/admin/disputes/:id/resolve` |
| Admin financial decision (refund / release / split) | yes, explicit amounts | `POST /api/admin/disputes/:id/resolve-financial` |
| Dispute on a COMPLETED project | allowed to open and to close by text; **never claws back** | financial path refuses (contract not ACTIVE / nothing held) |
| Several active disputes on one project | frozen until ALL are RESOLVED/REJECTED | freeze = count of active disputes |
| Disputes on OTHER projects of the same user | no effect | freeze is per project |

Paths audited: the only code that releases escrow, approves a stage or completes a project financially is `ProjectProgressService.reviewDelivery` (client route `POST /api/client/requests/:id/stages/:stageId/review`) and the new `DisputeService.resolveFinancial`. Both take the contract row lock. There is no cron/timer/auto-release anywhere, and no admin shortcut that approves stages. A static test fails if a new file writes `escrow`/`projectStage`. Amendments do not touch escrow here (another change adds their effects and calls `hasActiveDispute`).

### Race safety

`createForRequest` (open a dispute), `reviewDelivery` (approve) and `resolveFinancial` all start with `SELECT "id" FROM "contracts" WHERE "projectId" = $1 FOR UPDATE` (`lockProjectForFreezeCheck`). Whoever gets the lock second sees the first one's committed state: either the dispute exists before the approval's check (refused) or the release is fully committed before the dispute row is created. The same lock also makes "the same party opens two disputes at once" a clean 409.

## 2. Module `src/services/dispute-freeze.service.ts`

- `hasActiveDispute(projectId, db = prisma): Promise<boolean>` (alias `isProjectFrozen`) - pass the `tx` client to check inside a transaction.
- `countActiveDisputes`, `getActiveDisputeForProject`, `getFreezeState(projectId, db)` -> `{ frozen, activeDisputeCount, disputeId, disputeStatus, reason }`.
- `assertProjectNotFrozen(projectId, db)` throws `AppError(423, errors:[{code:'PROJECT_FROZEN_BY_DISPUTE'}])`.
- `lockProjectForFreezeCheck(tx, projectId)`.
- Disputes are matched by `projectId`, or by `requestId` for legacy requests (the project shares the request id).

## 3. Read model (both apps)

`GET /api/client/requests/:id/workspace` and `GET /api/provider/projects/:id/progress` (`getProjectProgress`) now also return:
`disputeFreeze { frozen, activeDisputeCount, disputeId, disputeStatus, reason }`, `activeDisputeCount`, `activeDisputeId`, `canApproveStage` (false when frozen or contract not ACTIVE), `approvalBlockedReason` (Arabic). `canUploadDelivery` / `canSubmitDelivery` are unchanged.
The client pending-review list (`getPendingReviewDeliveries`) items carry `frozen` and `approvalBlockedReason`.
`GET /api/client|provider/disputes/:id` and `GET /api/admin/disputes/:id` add `projectFreeze`, `resolutionLabel` (Arabic) and `financialOutcome` (null unless a financial decision was executed).

## 4. Admin resolution contract

### 4.1 Kind 1 - text closure / rejection (no financial effect)

`POST /api/admin/disputes/:id/resolve` (ADMIN / SUPER_ADMIN)

```json
{ "action": "resolve" | "reject", "resolution": "MUTUAL_CLOSE", "resolutionNote": "optional free text" }
```
- `resolution`: 2-120 chars. Recognised closure codes (shown in Arabic to users): `MUTUAL_CLOSE`, `NO_FINANCIAL_CHANGE`, `REJECTED_INSUFFICIENT_EVIDENCE`. Any other text is kept verbatim.
- A **bare financial code** (`REFUND_CLIENT`, `RELEASE_PROVIDER`, `SPLIT`, legacy `RELEASE_TO_PROVIDER`, `PARTIAL_REFUND`) is refused with 400 "هذا قرار مالي: استخدم مسار القرار المالي". The same words inside a sentence are plain inert text.
- Effects: status -> RESOLVED/REJECTED via a conditional update (double click = one execution, the other gets 409); audit `DISPUTE_RESOLVED|REJECTED` (`financialEffect: NONE`); both parties notified. No escrow, wallet, contract, project or stage change.
- Responses: 200 `{success, data: <dispute>}`; 400 validation; 404; 409 already decided.

### 4.2 Kind 2 - financial decision

`POST /api/admin/disputes/:id/resolve-financial` (ADMIN / SUPER_ADMIN **and** `authorizeAdminActing`: the acting role must be admin; an admin account acting as client/provider is refused)

```json
{
  "outcome": "REFUND_CLIENT" | "RELEASE_PROVIDER" | "SPLIT",
  "refundToClient": 0.00,
  "releaseToProvider": 0.00,
  "expectedHeldAmount": 0.00,
  "confirm": true,
  "resolutionNote": "optional free text"
}
```
Rules (all re-checked on the server inside one transaction):
- Amounts are USD numbers with at most 2 decimals, >= 0. `REFUND_CLIENT`: refund > 0 and release = 0. `RELEASE_PROVIDER`: release > 0 and refund = 0. `SPLIT`: both > 0.
- `refundToClient + releaseToProvider` must equal the **held unreleased escrow** (`price - releasedAmount`, escrow status HELD) exactly (full settlement; 400 otherwise). `expectedHeldAmount` is the figure the admin saw; a mismatch is 409 (stale view; response `errors[0].heldAmount` has the real value).
- `confirm` must be the literal `true`.
- Commission: `releaseToProvider` is GROSS. For a v2 escrow the commission is the escrow's snapshotted rate, computed with the cumulative `splitRelease`/round2 method (`utils/escrow-commission.ts`); the provider net is `gross - commission`; `platformCommissionAmount`/`providerNetReleasedAmount`/`releasedAmount` are updated cumulatively. A legacy escrow releases gross with no commission. The refund part carries no commission.
- Atomic transaction, in order: contract row lock; contract must be ACTIVE; claim dispute (OPEN|UNDER_REVIEW -> RESOLVED, `resolution = outcome`, `resolutionNote` verbatim); re-read escrow (HELD, held > 0); escrow -> `RELEASED` (release > 0) or `REFUNDED` (refund only) guarded by `status = HELD AND releasedAmount = <read value>`; client `walletBalance += refund` and `WalletTransaction { type: 'REFUND', referenceId: 'DISPUTE-REFUND-<disputeId>' }` (unique -> DB-level idempotency); contract COMPLETED (release > 0) or CANCELLED (refund only); project COMPLETED or DISPUTED; client request COMPLETED/CANCELLED; `AccountAuditLog DISPUTE_FINANCIAL_RESOLVED` (CRITICAL, admin id, amounts, rate, escrow before/after) **in the same transaction** (an audit failure rolls the money back). Notifications go out after commit.
- Idempotency: the dispute claim is conditional, so a second/concurrent execution matches 0 rows -> 409 and nothing moves.
- Money released earlier (including a COMPLETED project) is never touched: the contract is not ACTIVE / nothing is held -> 409.
- Response 200 `{success, data: { ...dispute, financialOutcome: { outcome, refundToClient, releaseToProvider, platformCommission, providerNet } }}`.

### 4.3 What the parties see

Resolution codes are replaced by Arabic labels (`resolutionLabelAr`): MUTUAL_CLOSE "إغلاق ودّي باتفاق الطرفين دون أي تغيير مالي", NO_FINANCIAL_CHANGE, REJECTED_INSUFFICIENT_EVIDENCE, REFUND_CLIENT "استرداد المبلغ المحتجز للعميل", RELEASE_PROVIDER "صرف المبلغ المحتجز لمقدم الخدمة", SPLIT "تقسيم المبلغ المحتجز بين الطرفين". Admin free text is kept verbatim inside «…». A financial code on a legacy row with no executed outcome is labelled "(قرار إداري لم يُنفَّذ ماليًا)". Notifications state the money effect ("لم يتغيّر أي مبلغ مالي" / "أُضيف X $ إلى محفظتك" / "صُرف لرصيدك N $ بعد خصم عمولة المنصة C $").

Links: provider -> `/provider-overview/disputes/<id>` (exists). Client -> there is NO client dispute-details route; the notification opens `/client-overview/disputes?dispute=<id>` and the client list page focuses that dispute.

## 5. Assumptions for owner review

- A1. A client **revision request** stays allowed during a dispute (it is not an approval and moves no money). The earlier proposal doc (option B) froze it too; say so if you want it frozen.
- A2. Financial resolution is a **full settlement** of the held balance (refund + release = held). Partial refunds that leave the rest held would need a `refundedAmount` column (no schema change was made).
- A3. Both ADMIN and SUPER_ADMIN may execute financial decisions (acting role must be admin). Restricting to SUPER_ADMIN is a one-line change.
- A4. A financial decision **closes the engagement**: refund-only -> contract CANCELLED, project DISPUTED (the only existing "closed by dispute" project status), request CANCELLED; any release -> contract/project/request COMPLETED. No gamification points, rating prompt or affiliate commission are triggered by an admin settlement.
- A5. Other active disputes on the same project are not auto-closed by a financial decision of one of them; the admin closes them by text.
- A6. Provider ledger: the provider balance is computed from the escrow, so the released net appears in the balance; the provider "transactions" list is derived from approved stages, so an admin release has no line there (and the finance page now lists only HELD escrows). A ledger line would need a small provider-finance addition.
- A7. Legacy escrows: only the contract price portion still held is refundable; the old 13% funding charge is not refunded.
- A8. 423 (Locked) is used for the freeze response.
- A9. Not verified: real Postgres row-lock behaviour and the Prisma `$queryRaw ... FOR UPDATE` against the live schema (unit tests model the lock; no DB was touched). Needs a staging check by the team.

## 6. Schema

None. `Dispute.status`, `Escrow.status/releasedAmount/platformCommissionAmount/providerNetReleasedAmount`, `WalletTransaction.referenceId` (unique), `AccountAuditLog` already exist. No migration, rollback or preview SQL is therefore attached.
