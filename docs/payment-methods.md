# Financial payment methods

Adds owner- and active-role-scoped payment-method management at `/api/payment-methods?role=CLIENT|PROVIDER|AFFILIATE`. The UI uses the same role-specific `paypalPayoutEmail` that existing onboarding and withdrawals read. An OAuth proof is additive metadata, never a second payout destination or a fallback to the login email.

## What is implemented

- PayPal authorization-code login/consent, one-use durable state bound to user, active role, session and environment; backend-only token exchange and userinfo read. No PayPal access/refresh tokens are persisted. Cancellation and failed exchanges need a fresh authorization.
- The PayPal-return page only completes the original tab's pending attempt and removes authorization query parameters immediately. It does not register a new Waseet account.
- Distinct PayPal subject/user ID fields, email confirmation and account verification claims. Missing flags remain unknown. Account verification is not inferred from a login or from email confirmation.
- A confirmed PayPal email is explicitly activated as the canonical role-profile destination. Provider activation retains the existing account-email OTP and 24-hour PayPal withdrawal freeze (including the audit event consumed by existing withdrawal enforcement). Client/affiliate activation also synchronizes the existing completion score; affiliate changes keep the existing financial-security notification.
- Legacy/manual destinations are shown as unlinked. Changes through old profile screens immediately invalidate the displayed current/default state of an older OAuth proof.
- Al Rajhi IBAN checksum/bank validation and AES-256-GCM authenticated storage; saving or editing is **not** ownership verification. Bank methods cannot become a payout default. Existing payout execution remains PayPal-only.
- Default preference is changed under a user row lock and a partial unique DB index. It never rewrites an existing withdrawal's destination snapshot.
- Disconnecting PayPal deletes the OAuth proof only; the existing canonical payout email remains and is displayed as unlinked. This consequence is explicitly confirmed in the UI. Deleting a bank method removes the saved bank details.

## External prerequisites

Set a dedicated random 32-byte key as **64 hexadecimal characters** in `PAYMENT_METHODS_ENCRYPTION_KEY`, stored only in the server secret/environment configuration. Do not use JWT_SECRET or PayPal credentials as this key. Back up the key securely alongside the encrypted database. Rotation requires re-encryption with the old key; do not replace the key blindly.

PayPal Connect uses separate configuration and never silently falls back to Checkout credentials:

```
PAYMENT_METHODS_ENV=sandbox # live on official only
PAYPAL_CONNECT_MODE=sandbox # must match the payment-method environment
PAYPAL_CONNECT_CLIENT_ID=<configured in secret store>
PAYPAL_CONNECT_CLIENT_SECRET=<configured in secret store>
PAYPAL_CONNECT_RETURN_URL=https://dev.waseetai.com/payment-methods/paypal-return
```

Official return URL: `https://waseetai.com/payment-methods/paypal-return` (or `www` if the whole authorization starts/returns there). Authorization must return to the **same frontend origin/tab** that started it: sessionStorage is origin-scoped. If both official hosts are used, redirect to the configured frontend origin **before** starting authorization. The frontend rejects a cross-origin Return URL before opening PayPal. Configure `PAYPAL_CONNECT_LIVE_APPROVED=true` only after actual PayPal approval; an approved Checkout application alone is insufficient. `PLATFORM_DEPLOY_ENV=official` enforces live mode. Configure the selected attributes (email, account verification status and account ID), privacy/terms URLs and exact Return URL in the PayPal developer dashboard.

No Al Rajhi/Open Banking/IBAN-ownership provider credentials or contract are present in the repository. A saved Al Rajhi account is explicitly unverified and cannot be activated for bank transfers. Ownership verification and bank disbursement are **not implemented/enabled**; select and authorize a provider integration separately. No fabricated verification callback, paid signup, bank credential form or manual admin-approval queue is added.

## Deployment

Migration `20261126150000_payment_methods` is additive and transactional. It has **not been executed against dev or production by this change**. Back up and inspect the target DB, apply this migration using the project's tracked migration process, generate Prisma Client, then deploy the backend before the frontend. Do not reset or db-push an existing environment or blindly execute unrelated pending migrations. App rollback may leave the additive tables in place. Do not drop them as an automatic rollback.

Review auth-code query redaction in frontend proxy access logs/monitoring, and avoid third-party scripts on the callback page. Only the frontend Return URL has the authorization code; backend exchange uses a POST body and does not log upstream bodies.

No balances, fees, KYC decisions, withdrawal snapshots or existing payment rails are migrated. The routes only manage methods and canonical destination activation; they do not create or execute payouts. Do not propagate the dev SEB branch into official releases.

## Validation

Run the payment-method utility tests, `payment-methods.pg.test.ts` against isolated PostgreSQL, existing PayPal email-change/withdrawal tests, the frontend payment-method component tests and onboarding guard tests, and both production builds. The PG test initializes the existing schema **then executes the actual new SQL migration**, including its custom constraints. Network doubles model PayPal token/userinfo responses; real sandbox login/consent still needs configured sandbox credentials and a human-owned test account. Real Live consent requires PayPal approval. Do not report either as verified by HTTP mocks.

Official reference: https://developer.paypal.com/log-in/build/
