# Support attachments and additional dispute evidence

This change completes the provider ticket picker and replaces the local-only dispute-evidence behaviour with server storage. The client ticket form is enabled too. Existing evidence links, account roles, identity icons and financial decisions are preserved.

## Contract

- `POST /api/{client|provider}/tickets` and `/api/marketer-overview/tickets` continue accepting JSON. Multipart adds up to **five `attachments` files**, each **1 byte–10 MiB**, JPEG/PNG/PDF. Fields remain those in `createSupportTicketSchema`.
- `submissionKey` is an optional UUID. The provider/client forms retain it on a failed request. Identical retries return the saved ticket; changing the payload under a used key returns 409. Ticket, initial message and attachment rows are one Prisma nested write.
- `POST /api/{client|provider}/disputes/:id/attachments` accepts multipart `attachments` and a UUID-v4 `requestKey`. Only an existing party can append, only while OPEN/UNDER_REVIEW. A row lock rechecks membership/status and serialises retries. The total is capped at 20, including legacy evidence. Nothing replaces the legacy `evidence` array.
- `GET .../:id/attachments` lists safe metadata. `GET .../:id/attachments/:attachmentId/download` rechecks parent access and returns a signed private download URL valid for 60 seconds. Both replies use `Cache-Control: no-store`.
- Staff read through `/api/admin/tickets/:id/attachments` (`support.review`) or `/api/admin/disputes/:id/attachments` (`disputes.view`). Role/department restrictions remain in the existing live permission middleware. Staff cannot append through these routes.
- Owner, uploader and creation time are persisted. A different case's file ID does not grant access. Storage refs and retry digests are not returned by file-list endpoints. The AI summary receives only additional file counts by party, never their private URLs or contents.

## Storage and failure behaviour

Uses the existing Cloudinary helper with **authenticated** delivery, server-generated storage names, byte-signature checks and the normal upload limiter. No arbitrary client URL is accepted for new attachments. Real Cloudinary configuration is required; the helper's `local-dev` placeholder mode is explicitly refused for files rather than claiming they were stored.

Uploading happens before binding. Partial upload or DB failure attempts deletion using the authenticated resource type. Cleanup failures are logged with the storage ID for operator follow-up; external storage and PostgreSQL cannot share a transaction. The frontend retains selected files/text on failure and reports success only after saved server metadata is returned. A retry with the same batch key creates no duplicate evidence. Already-issued signed links can remain usable for their 60-second lifetime.

Support uploads belong to the initial ticket. Attaching a new file to a staff reply is outside this change and remains explicitly disabled. Existing client/provider/marketer ticket detail and staff case detail screens can open the saved files. Client/provider dispute detail can append and read additional evidence.

## Migration and rollout — not executed on shared environments

`20261102120000_case_attachments` adds one empty table, two nullable ticket retry columns and indexes/checks. It does not relabel/convert money, modify old evidence, change users or grant permissions.

1. Recheck deployed heads and preserve any newer work. Take and restore-verify a backup.
2. Rehearse on a native isolated PostgreSQL copy of the target schema. Verify private storage is configured without exposing credentials. Local verification here used PGlite PostgreSQL/WASM, **not** a native PostgreSQL server.
3. Apply this migration, then BE, then FE. Keep the existing identity-aware FE deployment configuration.
4. With agreed QA accounts, check real private upload, refresh, staff read, cross-account denial, retry and closed-dispute denial. No user-facing SMTP/financial action is needed.

Code rollback keeps the table and saved files. Roll FE back before BE. The optional `rollback.sql` refuses once any file or keyed ticket exists; do not drop used attachment history.

## Verification recorded for this change

- Backend: **304/304** focused service, HTTP, ticket, dispute and route-permission tests; storage/identity fixtures are explicitly mocked. A local mutex fixture tests the retry branches but is not a native-PG locking proof.
- Frontend: **163/163** focused tests and a successful production build; actual multipart HTTP contracts, read-only mode, validation, waiting for confirmation, retry-key preservation, failure preservation, private download and existing case screens.
- Migration: full main schema plus old fixture rows, apply/unused rollback/reapply, parent/size constraints, unique submission key and refusal to roll back used data, on PGlite/WASM.
- No logged-in browser, live Cloudinary, native PostgreSQL concurrency or shared-server deployment is claimed by these tests.
