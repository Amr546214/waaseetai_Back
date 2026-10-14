# Dispute policy: current behavior vs proposed options

Status: DOCUMENTATION AND PROPOSAL ONLY. No behavior is changed by this document or by the PR that carries it. Line numbers are from `origin/main` at 8367bcd plus this PR (the files named here are not modified by this PR except where noted in the PR description).

## 1. Current behavior (precise)

### 1.1 Who can open a dispute

- Client: `POST /api/client/requests/:id/disputes`, role gate `clientOnly` (acting client) - `src/routes/client-requests.routes.ts:128` -> `openClientDispute`.
- Provider: `POST /api/provider/requests/:id/disputes`, role gate `providerOnly` (acting provider) - `src/routes/provider.routes.ts:206` -> `openProviderDispute`.
- Both end in `DisputeService.createForRequest` (`src/services/dispute.service.ts:107`).
  - Legacy request path (`requestForActor`, `:61`): the actor must own the request (client) or hold an ACCEPTED proposal (provider); request status must be COMPLETED or IN_PROGRESS; OPEN / PENDING_SIGNATURE gives "لا يمكن فتح نزاع قبل توقيع العقد من الطرفين وتمويل الضمان".
  - Marketplace / contract-backed project path (`projectForActor`, `:90`): the actor must be the contract's client or provider; contract status must be ACTIVE, COMPLETED or DISPUTED (`:100`); the three PENDING_* statuses are refused.
  - One OPEN/UNDER_REVIEW dispute per opener per project/request (`:113`, 409 otherwise). The other party may open its own.
- Admin can not open a dispute; admin routes only list, read, assign, add notes, set status and resolve (`src/routes/admin-disputes.routes.ts`).

### 1.2 What opening a dispute changes

- It creates one `Dispute` row with status OPEN (`dispute.service.ts:114-117`) and nothing else.
- It does NOT set `Contract.status` to DISPUTED (no code in `src/` ever assigns `ContractStatus.DISPUTED` or `ProjectStatus.DISPUTED`; they exist only as readable values, e.g. `utils/request-lifecycle.ts:55`, `utils/delivery-state.ts:14`). The contract stays ACTIVE, the project stays IN_PROGRESS, the escrow stays HELD.
- The UI/API only learn about the dispute through a read: `project-progress.service.getProjectProgress` and the provider active list look up an OPEN/UNDER_REVIEW dispute and expose `disputeStatus` (`src/services/project-progress.service.ts:200`, `src/controllers/provider.controller.ts` active list). This is display only.

### 1.3 What is still allowed while a dispute is OPEN / UNDER_REVIEW

| Action | Allowed? | Where |
| --- | --- | --- |
| Provider uploads delivery files | Yes | `assertDeliverable` checks only contract ACTIVE and stage IN_PROGRESS / REVISION_REQUESTED (`project-progress.service.ts:332-338`) |
| Provider submits a delivery | Yes | `submitDelivery` (`:351`) uses the same guard |
| Client approves a stage | Yes | `reviewDelivery` (`:384`) requires contract ACTIVE and stage SUBMITTED; no dispute check |
| Client requests a revision | Yes | same function |
| Escrow release on approval | Yes, normal | approval path in `reviewDelivery`: intermediate stage release splits commission and increments `Escrow.releasedAmount` (`:440-445`); the last stage sets the escrow RELEASED (`:506-510`); commission, net, ledger, notifications all as normal |
| Project completion and rating | Yes | final approval completes contract and project |
| Provider withdrawal of already released net | Yes | withdrawal logic does not look at disputes |
| Amendments | Yes | `createAmendment` requires only an ACTIVE contract |
| Provider cancels the request | No for a funded ACTIVE contract (409, "افتح نزاعاً ...") | `cancelByProvider`, `dispute.service.ts:129-145` |
| New purchase of the same service | Blocked while the contract is ACTIVE/DISPUTED | `utils/active-purchase.util.ts:21` |

So a dispute today is informational: the contract keeps running and money keeps moving exactly as if no dispute existed.

### 1.4 Notifications that fire

- On open: the provider gets "تم فتح نزاع ضدك" (opened by client) or "تم تسجيل نزاعك" (opened by provider) - `provider-notifications.service.ts:50`; the client gets "تم فتح نزاع على مشروعك" or "تم تسجيل نزاعك" - `client-notifications.service.ts:87`; admins get `NEW_DISPUTE` via `notifyAdmins` (`dispute.service.ts:125`).
- On resolve/reject: both parties get "تم حسم النزاع" / "تم إغلاق النزاع دون قبوله" with the decision text trimmed to 120 characters (`provider-notifications.service.ts:60`, `client-notifications.service.ts:93`).
- No notification is sent for OPEN <-> UNDER_REVIEW status changes, assignment or admin notes (audit rows only).

### 1.5 What the admin can do

- List/read (with an AI summary of the dispute and project, `generateAiSummary`, `dispute.service.ts:301`), assign to another admin (`:237`), add internal notes (`:246`), move OPEN <-> UNDER_REVIEW (`setStatus`, `:255`).
- Resolve or reject (`resolve`, `:263`): sets status RESOLVED or REJECTED, stores `resolution` text, `resolutionNote`, `resolvedById`, `resolvedAt`, writes an admin audit row, notifies both parties. It NEVER moves money: no escrow release, no refund, no cancellation, no contract/project status change. The decision text is a statement only; any financial follow-up is manual and outside the system. (Validation of the resolve payload is handled in another PR and is out of scope here.)

### 1.6 Summary of the gap

The product text promises that a dispute leads to "الفصل وإعادة المبلغ المحتجز عبر الإدارة" (`dispute.service.ts:142`), and the delivery state labels even say "العقد قيد نزاع، والتسليم موقوف حتى حسم النزاع" (`utils/delivery-state.ts:14`) for contract status DISPUTED, but in practice nothing ever puts a contract in DISPUTED and the admin resolution cannot act on the escrow.

## 2. Options

### Option A - keep as is (documented, informational dispute)

- Behavior: exactly section 1. A dispute is a ticket with a legal-style record.
- Pros: no risk, no migration, no stuck projects.
- Cons: the client can approve (and release) a stage while a dispute about that same project is open; the admin can say "refund the client" but cannot do it; wording in the UI ("التسليم موقوف", "الفصل وإعادة المبلغ") is not backed by behavior.
- Required changes: none (optionally fix the two misleading strings).

### Option B - freeze escrow release and approvals, allow delivery uploads

- Behavior while OPEN/UNDER_REVIEW: the provider can still upload and submit deliveries (work is not blocked and evidence accumulates); the client can NOT approve or request revision; no escrow release or completion happens; withdrawals of already released net are unaffected.
- Financial consequence: the unreleased balance stays HELD until the admin decides; the provider is not paid for delivered work during the dispute, but is not blocked from working; the client cannot release money to a provider they are disputing.
- UX: the review screen shows "المراجعة والاعتماد موقوفان بسبب نزاع مفتوح"; stage cards show SUBMITTED / awaiting admin; the provider list shows `disputeStatus`.
- States/transitions required:
  - A derived flag `frozen = exists Dispute(projectId, status in OPEN, UNDER_REVIEW)` read inside `reviewDelivery` (and any other release path), checked inside the same transaction as the stage/escrow update (race safe), or a stored `Contract.status = DISPUTED` with `ACTIVE <-> DISPUTED` transitions on open and on resolve/reject (a stored status needs both parties and all readers - `delivery-state`, `active-purchase`, lists - to agree, and the existing label code already anticipates it).
  - `assertDeliverable` must keep allowing uploads when DISPUTED (today it requires ACTIVE), so a stored status needs a separate "uploads allowed" rule.
  - Resolve must restore ACTIVE (or move to COMPLETED/CANCELLED according to the decision).
- Admin resolve with money (the real value of B): add explicit resolution actions - RELEASE_TO_PROVIDER (gross, with the normal commission split), REFUND_TO_CLIENT (escrow REFUNDED, client wallet credit, WalletTransaction), SPLIT (amount to each), NO_MONEY (today's behavior). This needs a money workflow with audit, confirmation and rounding rules.
- Decisions needed: freeze by derived flag or stored status; who is notified when a freeze starts and ends; auto-release or auto-refund after N days without a decision.

### Option C - full freeze

- Behavior: contract DISPUTED; no uploads, no submissions, no approvals, no revisions, no amendments, no new messages-driven actions; the project clock stops (or keeps running by decision); only the admin acts.
- Financial consequence: nothing moves at all; honest and simple, but a bad-faith dispute can block both parties and delay payment indefinitely; the admin SLA becomes critical.
- UX: both dashboards show a frozen banner; all action buttons disabled with the reason (the strings in `delivery-state.ts` already match this option).
- States/transitions required: stored `Contract.status` ACTIVE -> DISPUTED on open (by either party), DISPUTED -> ACTIVE on REJECTED (dispute dismissed), DISPUTED -> COMPLETED / CANCELLED on RESOLVED depending on the money decision; `Project.status` mirrored; time-tracking decision (pause `durationDays` countdown or not); a dispute cannot be opened on a contract that is already DISPUTED by the same party (existing 409 rule remains).
- Decisions needed: does the clock pause; maximum freeze length; are chat messages still allowed (recommended yes, as evidence).

## 3. Comparison

| | A keep | B freeze money, allow delivery | C full freeze |
| --- | --- | --- | --- |
| Provider can keep working | yes | yes | no |
| Client can approve/release during dispute | yes | no | no |
| Admin decision can move money | no | only if resolve actions are added | only if resolve actions are added |
| New states/migration | none | derived flag: none; stored DISPUTED: no migration (enum value exists) | stored DISPUTED, time-pause fields possibly |
| Risk | paying out a disputed stage | provider unpaid while delivering | everyone blocked, timeline stalls |
| Effort | none | medium | medium-high |

## 4. Recommended path (for discussion, not implemented)

B with a derived flag first (no schema change, one guard in the release path plus UI banner), then extend the admin resolve with explicit money actions in a separate, separately approved financial design (it is the only way the dispute can actually settle anything). C only if the owner prefers legal certainty over continuity.

## 5. Decisions needed from the owner

1. Which option: A, B or C.
2. Should a stored `Contract.status = DISPUTED` be used (and by whom is it set) or a derived flag read from the dispute table.
3. Should the admin's resolution be able to release or refund money? Which actions (release, refund, split), with what confirmation and audit?
4. Time limits: maximum days an OPEN dispute can stay unresolved; auto-escalation; auto-release/refund fallback.
5. Does the project clock (`durationDays`, `daysLeft`, late status) pause during a dispute?
6. Can amendments, cancellation and new service purchases from the same provider happen while a dispute is open?
7. Notification wording and whether OPEN <-> UNDER_REVIEW changes should notify both parties.
8. Whether a dispute may be opened on a COMPLETED contract (allowed today) and what a freeze means then (the money is already released).
