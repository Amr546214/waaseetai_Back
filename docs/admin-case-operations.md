# Admin case operations

## Before deploying

Integrate the support/dispute queue PRs first. Rehearse the additive migration
`20261107153000_admin_operations` on a restored dev backup. Apply it before
starting the new backend; deploy the frontend after the backend. The old app
can still read the schema if the containers are rolled back. Leave the migration
in place during a container rollback; dropping columns/tables would discard
reports and reply attachment associations.

## Staff reply files and reports

Staff replies accept up to five JPG, PNG or PDF files, each up to 10 MiB, through
the existing private case-file storage. Text, case attachment metadata and
the reply relation commit together. A reply retry with the same key and data
does not send a second message. The ticket owner and authorized support staff
can open the files through the existing expiring download endpoint.

Signed-in users can report a public provider account or a published marketplace
service. Only one open report per person and target is allowed. Staff need
`reports.view` to read and `reports.manage` as well to save a final decision.
Closing a report does not suspend an account or hide a listing.

## Optional automatic escalation

Disabled by default. The worker requires:

- `CASE_SLA_ENABLED=true`.
- `CASE_SLA_FROM`: explicit ISO UTC cutoff (for example the rollout time);
  older cases are excluded.
- `SUPPORT_SLA_TARGET_ADMIN_ID` and/or `DISPUTE_SLA_TARGET_ADMIN_ID`: account IDs
  selected by the team. Support requires an active account with `support.review`
  and `support.reply`. Disputes require `disputes.view` and `disputes.resolve`.
  A missing or ineligible target is never assigned.
- Optional `SUPPORT_SLA_FIRST_REPLY_HOURS` in low, normal, high, urgent order.
  Defaults to `48,24,8,2` elapsed hours, including weekends.

The scheduler runs once per minute, up to 25 tickets and 25 disputes per pass.
Only open/in-progress tickets without a staff reply can escalate; unresolved
open or under-review disputes escalate after seven elapsed days. Cases with a
previous manual escalation are skipped. Automatic assignment and its reason
are recorded once in the audit log; no public reply or case-state change is made.

## Preflight and final QA

Run `node --import tsx src/scripts/check-case-sla.ts` with the intended settings and database before activation. The command only reads configuration and staff access; it never assigns cases, starts the scheduler, or prints staff IDs. Use a UTC cutoff ending in `Z` (for example `2026-11-08T15:00:00Z`). It reports `disabled`, `invalid` (with the setting name), `ineligible`, `scheduled`, or `ready`. Invalid or ineligible exits nonzero. A future cutoff is scheduled, not active. Leave the worker off until operations has selected eligible staff and approved the rollout cutoff.

A saved report decision also creates one notification addressed to the reporter. The report decision, audit entry and notification commit together; the report text and private staff notes are not copied into the notification. Socket and optional mail delivery follow the existing notification preferences.

After a separately approved dev deploy, sign in as a reporter, a report viewer, and a decision manager. File a report, verify that the viewer cannot decide, decide as the manager, verify the audit entry and one notification on the reporter's own account, then repeat the decision and verify it conflicts without a second notification. Check support attachment download as the ticket owner versus an outsider. Confirm the escalation queue and seven-day dispute filter with QA cases. Verify the scheduler with approved test assignees and the intended cutoff before leaving it enabled.
