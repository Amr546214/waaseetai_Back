# «الإلغاء بالتراضي» (mutual cancellation) — implemented lifecycle and the decisions still open

Status: request lifecycle implemented, money OFF. Migration `20261105120000_contract_cancellation_requests` is additive, rehearsed only on a local database, NOT executed on dev/prod.

## What exists
- Table `contract_cancellation_requests` (one row per request). States: `PENDING_OTHER_PARTY` -> `ACCEPTED` | `REJECTED` | `WITHDRAWN`. `settlementStatus`: `NOT_APPLICABLE`, or `PENDING_ADMIN_DECISION` after an acceptance.
- DB rules: at most one PENDING-or-ACCEPTED request per contract (partial unique index), the requester must be one of the two parties (CHECK), `(requestedById, requestKey)` unique (idempotent submit).
- Only an ACTIVE contract with no OPEN / UNDER_REVIEW dispute can be asked to cancel; the same dispute check runs again when the other party accepts.
- API: client `GET|POST /api/client/projects/:projectId/cancellation-requests`, `POST /api/client/projects/cancellation-requests/:id/{respond,withdraw}`; provider `GET|POST /api/provider/projects/:projectId/cancellation-requests`, `POST /api/provider/cancellation-requests/:id/{respond,withdraw}`; admin read-only `GET /api/admin/cancellation-requests[/:id]` (`disputes.view`). Outsiders get 404, the requester cannot answer their own request (403), only the requester can withdraw (403).
- After each change: one system message in the project chat room (deterministic key), a notification to the other party, and an admin notification (`CANCELLATION_REQUESTED`, holders of `disputes.view`) on request and on acceptance.

## What it never does (until the decisions below are made)
It does not touch the contract status, the escrow, the wallets, the stages or any wallet transaction (guarded by `contract-cancellation.static.test.ts` and the pg test that compares a full snapshot before/after). Nothing released to approved milestones can be affected because nothing is moved. The text shown to users says so.

## Decisions needed (nothing below is invented in code)
1. Settlement rule: when both parties agree, what happens to the held unreleased escrow (price - releasedAmount)? Options: (a) full refund of the held part to the client, released milestones stay with the provider; (b) refund minus a share for work in progress / submitted-not-approved stages, with the share set by the admin per case (as the dispute financial decision already does: explicit amounts, refund + release = held); (c) the parties propose the split and the admin only approves it. Recommendation: (b), reusing the approved `resolve-financial` mechanics (explicit amounts, commission on the gross release, atomic transaction, full settlement) so no second money path exists.
2. Who in the administration approves it and with which permission (today read-only with `disputes.view`). Recommendation: the same pair as the financial dispute decision (`disputes.resolve` + `payouts.send`), acting-role guarded.
3. State after an agreed cancellation: should the contract become CANCELLED (and the project/request), and should stage approval / delivery be frozen from the moment of acceptance? Today nothing changes after acceptance. Recommendation: freeze approvals at acceptance, close the contract only together with the settlement.
4. Expiry: should a PENDING request lapse after N days, and may either party cancel after the other accepted but before settlement?
5. Opening during a dispute: today refused (409). Confirm.
