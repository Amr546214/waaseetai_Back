# Operations panel review fixes (PR #241)

No deployment, shared migration, shared backup, cache purge or recovery is performed by this change.

## Settings and maintenance

Operations access is available to active Super Admins on both dev and the official deployment. `officialDeployment` remains diagnostic metadata only. Do not set dev as `PLATFORM_DEPLOY_ENV=official` to gain access; no environment flag is required. Each environment uses its own configured database and service connections.

- Every canonical settings write increments the private `__platform_public_revision` row and queues PostgreSQL NOTIFY **inside the same transaction** as the setting versions and audit entry. CMS terms/privacy publication does the same. A rolled-back audit sends no notification.
- The public settings snapshot and maintenance state carry that database revision. The browser rejects older HTTP/socket/503 snapshots, then reloads all public settings when the revision advances. Fallback state polling is every five seconds; the server settings cache TTL is five seconds.
- The maintenance login exception includes OTP, password recovery and Google callback screens. It does not exempt registration or regular application routes.
- Unversioned legacy settings writes return 410. Both legacy mounts require an active Super Admin, including reads, on dev and the official deployment.

## Login guard

Deploy the existing `20261114100000_login_guard_state` migration, then the additive `20261114110000_login_guard_reservations` migration before starting this backend. These are not applied by this PR.

A shared reservation is acquired before checking credentials. Concurrent checks reserve remaining capacity; their HTTP JSON response is sent only after their result has committed. Only 401 increments failures. Abort, validation, 429 and server errors release capacity. Reservations expire after two minutes; the HTTP watchdog is 90 seconds.

When shared storage is available, it replaces the old process-local failure counters and progressive account delay for password login. The independent flood guard remains. Without the new tables the old protection remains active and a throttled warning is logged. OTP/Google limits are unchanged.

The pair/IP policy is configurable. The account-wide layer remains a progressive delay for unrecognized origins (30 seconds up to 15 minutes), rather than an indefinite lock. A known origin skips only that delay. Clearing an active pair/IP block also clears its associated account delay in the same transaction as the audit entry. The IP maximum cannot be lower than the pair maximum. Existing active block expiries are retained when policy changes.

## Cloudflare adapter

Configure independently for each environment (dev and official):

- `CDN_PROVIDER=cloudflare`
- `CDN_ZONE_ID`: 32 hex characters
- `CDN_API_TOKEN`: scoped to this zone, with Zone Read, Analytics Read and Cache Purge permissions
- `FRONTEND_URL`: the HTTPS site for this environment

The adapter reads zone status and 24 completed hours of `httpRequests1hGroups` counters. An unavailable analytics entitlement/permission is shown as unavailable, not zero. Purge accepts 1–30 explicit HTTPS file URLs on the exact configured hostname of this environment, with a reason, confirmation and UUID Idempotency-Key. It never purges the whole zone implicitly. Provider acceptance is labelled as acceptance. An uncertain purge is not automatically repeated.

## Backup agent

Run `node scripts/backup-agent/server.mjs` as a separate supervised service, not inside the API process. It needs installed PostgreSQL client tools of a compatible version (`pg_dump`, `pg_restore`) and these server-side settings:

- `BACKUP_DIR`: absolute private durable directory; mode 0700, not shared with untrusted writers
- `SOURCE_DATABASE_URL`: source database, least privileges needed for the chosen backup
- `RESTORE_DATABASE_URL`: **separate recovery database**, never the live source database; the recovery role needs privileges to restore and read `pg_control_system()`
- `BACKUP_AGENT_TOKEN`: random secret of at least 32 characters, shared only with the API service
- Optional `PG_DUMP_BIN`, `PG_RESTORE_BIN`, `BACKUP_AGENT_HOST` (default 127.0.0.1), `BACKUP_AGENT_PORT` (default 5098)

Configure the API with `BACKUP_AGENT_URL` and the same `BACKUP_AGENT_TOKEN`. Use loopback/private service networking, never expose the agent publicly; use HTTPS when the private transport crosses hosts. No credentials reach the browser. For Docker, use a private network and a persistent volume, and bind the agent only to that network. This PR does not install or start that service on any shared server.

A backup is a custom-format pg_dump archive with SHA256 and a durable manifest. Agent jobs survive restarts and use the same UUID for retries. At most one job executes, with at most five pending. A running job interrupted by a restart is marked INTERRUPTED, never automatically rerun. Files and job manifests reject traversal and symlinks. Restore accepts only an agent-created successful archive with a matching checksum. The source/recovery database identities (cluster system identifier + database OID) must differ. Restore uses a single transaction with exit-on-error, into the recovery database. It **does not switch the running application to that database**. Switching the live connection remains a separate operational change after checking the recovered database.

The agent uses an exclusive `.agent.lock`. After an unclean stop, the supervisor/operator must verify the former process is gone before removing that stale lock and restarting. No automatic stale-lock removal can start two workers on the same directory.

Each UI action requires a reason, exact confirmation and a UUID idempotency key. An audit intent is committed before contacting the agent/provider; the tracked result distinguishes queued, running, succeeded, failed and interrupted. If the API response is lost, retry the same action with the same key or query the job. The old audit-only restore endpoint returns 410.

## Verification

Targeted regressions cover maintenance auth paths, stale snapshots, public-settings refresh, identity changes and retryable access; shared Postgres concurrency, configured limits and unblock audit rollback; Cloudflare response/error validation; agent authentication, idempotency, restart, checksum and separate-database recovery. No real provider credentials or production data are used.
