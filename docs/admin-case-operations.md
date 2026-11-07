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
