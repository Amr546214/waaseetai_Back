# Admin feature batch — implementation and unresolved product rules

## Implemented in this batch
- Read-only AI console, specialty/accreditation audit metadata, and stored offer matching scores.
- Timing of the first administrative support reply. SLA metrics use the existing enabled case policy; missing/disabled policy does not become 0% success.
- Own admin avatar upload/removal via existing image storage, with the profile row and audit row committed together.
- Display of the existing mandatory email login-code policy. Password and Google login already require this code. No login policy is weakened or changed.

## Features still blocked — these are not implemented by this batch
### Government fees
There is no government-fee ledger or provider integration in the current schema.
Required product decisions: applicable jurisdictions, the source of the fee/tax, liable payer, currency and rounding, invoice/legal document format, and whether the platform collects or only records the amount.
Do not infer a tax/fee from a commission or wallet transaction.

### Scheduled invoices
There is no scheduler or invoice-issuance integration for future billing.
Required decisions: billable event, recurrence and time zone, payer/payee, currency, cancellation/overdue behavior, and whether the platform only issues invoices or also charges automatically.
No payment mandate, retry policy, or automatic charge has been added.

### Cashback
There is no approved active cashback policy or distribution ledger.
Required decisions: funding party, qualifying transaction/event, rate or fixed amount and cap, eligibility period, availability/withdrawal rules, cancellation/refund reversal, currency and rounding.
A stored discount is not cashback. This batch never credits a wallet or changes commission/escrow.

### Staff satisfaction and task SLA
Customer reviews in the schema rate providers/projects, not admin staff.
To collect staff satisfaction, define the rated interaction, rating scale, eligible respondent, time window, staff attribution and edit policy.
The support-response panel is a service timing measurement, not a personal staff rating.
Task on-time rates continue to use each task's stored due date; no unapproved target or composite score is introduced.

### Authenticator-app MFA
No TOTP/WebAuthn enrollment, recovery or verification path exists. This batch does not build or claim one.
The account screen distinguishes the already mandatory email login challenge from an authenticator app.
A separate authenticator implementation must cover all login/session issuance and recovery paths and be tested as an authentication change.

## Validation and deployment
- No schema migration is introduced by this batch.
- No model requests, billing, notifications, email or OTP are sent by these admin reads.
- No deployment or runtime flag change is part of this batch.
- Local validation here is limited to pure unit tests, source-isolated service/component smoke tests and TypeScript syntax parsing.
- Full TypeScript/Angular builds, HTTP tests with the application's dependencies, live PostgreSQL queries and real image storage must be run in a complete checkout before deployment.
