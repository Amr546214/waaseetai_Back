# Automatic support / dispute escalation: readiness and owner decisions

**State: CLOSED.** Nothing in the admin panel enables, schedules or runs it. The readiness screen (`/supper-admin-overview/it/escalation-readiness`, API `GET /api/admin/system-settings/escalation-readiness`) is read-only: it assigns nothing and sends no notification.

## Rules in code today (`src/services/case-sla.service.ts`)
- **Support tickets:** first admin reply due after 48 / 24 / 8 / 2 hours for low / normal / high / urgent priority. These are the built-in defaults; `SUPPORT_SLA_FIRST_REPLY_HOURS` (four comma-separated values, 1 to 720) replaces them. An overdue ticket with no admin reply is assigned to the support assignee.
- **Disputes:** an OPEN / UNDER_REVIEW dispute older than **168 hours (7 days)** is assigned to the disputes assignee. Fixed in code, not per priority.
- Only cases created at or after `CASE_SLA_FROM` are considered. The sweep runs every 60 seconds once enabled.

## Environment variables the backend reads
| variable | meaning |
|---|---|
| `CASE_SLA_ENABLED` | must be exactly `true` to enable the worker (unset today) |
| `CASE_SLA_FROM` | UTC start, `YYYY-MM-DDTHH:mm:ss(.sss)Z` |
| `SUPPORT_SLA_TARGET_ADMIN_ID` | user id of the support assignee |
| `DISPUTE_SLA_TARGET_ADMIN_ID` | user id of the disputes assignee |
| `SUPPORT_SLA_FIRST_REPLY_HOURS` | optional, e.g. `48,24,8,2` |

## Decisions required from the owners (all OPEN)
1. Who is the support assignee. Must be an existing, ACTIVE staff member holding `support.review` and `support.reply`.
2. Who is the disputes assignee. Must be an existing, ACTIVE staff member holding `disputes.view` and `disputes.resolve`.
3. The first-response hours per priority (low / normal / high / urgent), or accept the defaults 48/24/8/2.
4. The UTC start date (older cases are never escalated).
5. Whether the disputes rule stays at 168 hours for every priority.
6. Whether automatic escalation should be opened at all.

## Activation checklist (NOT executed; for the owners and the infra team)
1. Decisions 1-6 recorded.
2. The readiness screen shows every precondition as met (assignees ACTIVE with the permissions, start date valid, hours explicit).
3. Set the four values above in the API environment WITHOUT `CASE_SLA_ENABLED`, redeploy, confirm the screen still says closed and every precondition is met. Optional: `npx tsx src/scripts/check-case-sla.ts`.
4. Choose a start date in the future, set `CASE_SLA_ENABLED=true`, redeploy. The worker starts with the process.
5. Watch the first sweeps (`TICKET_ASSIGNED` / `DISPUTE_ASSIGNED` audit events with `escalationReason`); rollback = unset `CASE_SLA_ENABLED` and redeploy.
