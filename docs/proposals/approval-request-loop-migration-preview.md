# Approval request loop (completion required, history, proof uploads): migration preview (NOT EXECUTED)

Migration `20261018010000_approval_request_loop` (Batch B, track T1). Needs the owner's approval before it runs on dev.

## What it adds (all additive, idempotent)
- enum value `AccreditationStatus.NEEDS_COMPLETION` (admin asked for more data; this is not a rejection).
- enum `ProofUploadStatus` (UPLOADING / COMPLETED / FAILED / CANCELLED).
- `accreditation_samples`: `userNote` (admin note shown to the provider), `internalNote` (admin only, never returned to a provider), `completionFields text[]`, `revision int default 1`, `decidedAt`.
- table `accreditation_sample_events`: the review history of one request (never deleted on resubmission).
- table `accreditation_proof_uploads`: a proof file tied to the uploading user AND the request (provider specialty, then the sample once submitted); only `COMPLETED` counts.

## Effect on existing data
None. No UPDATE/DELETE. Existing samples keep status, files and links; `revision = 1`, notes NULL, `completionFields = {}`.
Old approvals are NOT cancelled by the new proof validation (it only applies to new submissions). Historical inconsistencies are reported, not fixed (see the final report).

## Rollback
`rollback.sql` is self-protecting: it refuses when any request is `NEEDS_COMPLETION`, any event/admin note exists, or any proof upload row exists. The enum value cannot be dropped by PostgreSQL and stays (unused).

## Order
migrations first (additive, the OLD backend and OLD frontend keep working on the migrated schema: proven on an isolated database), then the NEW FE, then the NEW BE (see qa-final-2026-10-14/DEPLOY-ORDER-BATCH-B.md). The new BE reads/writes the new columns; it must not start before the migration. Before any BE rollback check `select count(*) from accreditation_samples where status='NEEDS_COMPLETION'` is 0 (the old Prisma client throws on that enum value).
