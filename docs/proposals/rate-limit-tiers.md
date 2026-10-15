# Rate limit at the root: tiers, numbers, and what must be verified on the server (NOT EXECUTED anywhere)

## Diagnosis (code only; no server access)
Layers in the repo: (1) host nginx (template `deploy/nginx/waseetai-backend.conf.example`: `X-Forwarded-For: $proxy_add_x_forwarded_for`, `client_max_body_size 15M`, NO `limit_req`); (2) Express `trust proxy` (was hard-coded `'uniquelocal'`, now `TRUST_PROXY`, default unchanged); (3) express-rate-limit in-memory stores (single process: `compose.yaml` runs one `api` container); (4) OTP-send sliding windows in memory (`otp-send-throttle.ts`); (5) socket AI cooldown in memory (`socket-ai-rate-limit.ts`); (6) multer size/count limits per route; (7) LLM client budgets (`services/llm/llm.limits.ts`).
Root cause of the recurring 429: ONE global bucket of 100 requests / 15 min keyed by IP, counted BEFORE authentication, shared by every account and every endpoint (reads, writes, polling-like layout calls). The measured sessions below make 1.5-2.5 API calls per page even with empty data, so one person exhausts it in ~40-60 page views and a second QA user on the same IP (and the VPS) shares it.
Spoofing: with `uniquelocal` Express takes the right-most address that is not private; nginx appends the real client on the right, so a forged leading entry is ignored; a caller that reaches the published port directly has a public address that is not trusted, so its header is ignored (tests: `config/trust-proxy.test.ts`, `middlewares/tiered-rate-limit.test.ts`). Different users behind the proxy are separated only if `req.ip` is the real client: see server checks.
IPv6: keys go through `ipKeyGenerator` (/56). 

## Limiters before / after
| Tier | Before | After (per 15 min unless noted) | Key | Store |
|---|---|---|---|---|
| global reads (GET/HEAD) | shared 100 / IP | 900 / account; 300 / anonymous address; 4500 / address safety net (authenticated traffic) | verified JWT user id, else trusted IP | memory |
| global writes | shared with reads | 240 / account; 120 / anon address; 1200 / address net | same | memory |
| dashboard summaries | 600 / IP | 300 / account (own counter, also counted in reads) | same | memory |
| login, Google, login 2nd step | 10 / h / IP (all requests, one shared bucket) | see "Pre-authentication tiers" below | account / account+IP / IP | bounded memory (or postgres) |
| OTP verify | 10 / h per IP+identifier, 50 / h per IP | same two + 30 / h per account from all IPs | IP+identifier / IP / identifier | bounded memory (or postgres) |
| authenticated changes (password, sessions) still on `authLimiter` | 10 / h / IP | unchanged | trusted IP | memory or postgres |
| OTP send | 1/60 s + 5/h per recipient, 30/h per IP | unchanged | recipient / IP | memory |
| AI HTTP | 30 / IP | 30 / account, 30 / anon address, 150 / address net | same | memory or postgres |
| AI sockets | 30 / user | unchanged | user | memory |
| upload (every multer route, centrally in `memoryUpload`) | none (global only) | 40 / account, 20 / anon address, 200 / net | same | memory or postgres |
| payment (PayPal create/capture, checkout init/confirm/resend, escrow deposit, amendment funding/OTP) | none | 20 / account, 10 / anon, 100 / net | same | memory or postgres |
| withdrawal (provider, marketer) | none | 10 / h / account, 5 / h anon, 50 / h net | same | memory or postgres |
| PayPal webhook | counted in the 100 / IP | own bucket 1200 / IP (signature check stays the protection) | IP | memory |
| socket handshake | none | 120 / 5 min / account | user | memory |
| /health | counted | not counted | - | - |

Why these numbers (measured, `tools/measure-session-requests.mjs` in the FE worktree: real FE bundle in headless Chrome against a local STUB API, one full load + SPA navigations, empty data; result in `rate-limit-session-measurement.json`): client 18 API calls / 12 pages (1.5), provider 28 / 12 (2.3; `access-state` is asked on every navigation by design), affiliate 24 / 10 (2.4), super admin 10 / 8 (1.3). Real data adds detail/list calls; a x3 allowance gives ~7 calls/page, so a very heavy 15-minute session of 60 page views is ~420 reads: browse 900 per account = about 2x margin. Writes: a long form-filling session is well under 240. Strict tiers are sized from the business actions (a handful of payments or withdrawals per window), not from browsing. All values are env-overridable (`RL_<TIER>_USER|IP|IP_NET|WINDOW_MS`).
Role switch and token refresh keep the bucket (key = account id). Forged/expired tokens and `X-User-Id` are ignored (anonymous, counted on the address).
429 body: message in Arabic + `Retry-After` header + `errors[0] = { code: 'RATE_LIMITED', tier, retryAfterSeconds }`.

## Pre-authentication tiers (batch D, login limiter redesign)
Problem: login/Google/login-step shared ONE bucket of 10 requests per hour per IP, counted for successes too, so an office/NAT of honest users (or one user on a shared network) was blocked, while guessing against ONE account from many IPs was not limited at all. Account protection is now separate from address protection. Identifier = email (login) or userId (login steps), taken from the schema-validated body, trimmed + lower-cased, max 254 chars; nothing is looked up in the database, so an unknown identifier has the same counter and the same 429 as an existing one. The address comes only from `req.ip` (trusted resolver; X-Forwarded-For, X-Real-IP, X-User-Id are never read). Limiters run AFTER schema validation (bad bodies create no keys). Counter is raised before the handler (concurrent guesses cannot slip through) and handed back on a success (status < 400), except the flood guard which counts everything.

| Endpoint | Bucket (key) | Counts | Old | New / window | Why |
|---|---|---|---|---|---|
| POST /auth/login | address flood (IP) | every request | 10 / h | 300 / h | an office of 100 honest users logging in once an hour fits; only bounds raw volume |
| | address spraying (IP) | failures | (same 10) | 60 / h | 30 users with 2 typos each fit; an attacker gets 60 guesses/h/IP across ALL accounts instead of unlimited accounts at 10 |
| | one account from one address (IP+email) | failures | (same 10) | 6 / h, lockout x2, x4 | guessing one account from one place is tighter than before (10 -> 6); a user with a typo or two is fine |
| | one account from all addresses (email) | failures | none | 20 / h, lockout x2, x4, x8 (max 8 h) | distributed guessing is capped at 20 tries/h whatever the number of IPs (<= 480/day) |
| POST /auth/google | IP flood / IP failures | all / failures | 10 / h | 300 / h, 60 / h | no identifier before the token is verified, so address-only (Google verifies the token) |
| POST /auth/login/verify-otp, /login/resend-otp | IP flood / IP / IP+userId / userId | all / failures | 10 / h IP | 300 / 60 / 10 / 30 per h | the code row's own attempt counter (5) stays the real guess limit; these bound request volume. Separate buckets per route |
| POST /auth/verify-otp, /verify-reset-code, /reset-password | IP | failures | 50 / h | 50 / h (unchanged) | |
| | IP+identifier | failures | 10 / h | 10 / h (unchanged), lockout x2, x4 | OTP guessing is the most sensitive: NOT loosened |
| | identifier (all IPs) | failures | none | 30 / h, lockout up to x8 | new ceiling on distributed guessing of one account; strictly adds protection |
| OTP send (register, resend-otp, forgot-password) | recipient: 1/60 s + 5/h; IP 30/h | | same | same (unchanged); its in-memory maps are now capped at 20,000 keys each | recipient cooldown/caps untouched |

Progressive lockout: the first time a bucket passes its limit in a window it is a strike; strike 1 blocks until the window ends, strike 2 extends the block to 2 windows, strike 3 to 4, capped at the multiplier above. Strikes are forgotten after 24 h without a new one. `Retry-After` and `retryAfterSeconds` report the real (extended) wait. 429 body is the standard one: Arabic message, `Retry-After` header, `errors[0] = { code: 'RATE_LIMITED', tier, retryAfterSeconds }` with tier one of `login_ip_flood|login_ip|login_account_ip|login_account` (also `login_step_*`, `google_*`, `otp_verify_ip|otp_verify_account_ip|otp_verify_account`).
Memory bound: each bucket's store (`utils/bounded-rate-limit-store.ts`) holds at most 20,000 live keys (`RL_PREAUTH_MAX_KEYS`); windows expire keys (swept every <= 5 min); when full, expired keys are dropped first, then the least-recently-used key that is NOT locked, so flooding fresh identifiers cannot wash away an active lockout. Address buckets run first, so a flood of invented identifiers from one address is cut at the flood ceiling (300/h) before it creates keys. Roughly 100 bytes per key, so the worst case is a few MB per bucket.
Env overrides: `RL_LOGIN_ID_IP`, `RL_LOGIN_ID`, `RL_LOGIN_IP`, `RL_LOGIN_IP_ALL`, `RL_LOGIN_STEP_ID_IP|_ID|_IP`, `RL_OTPV_ID`, `RL_PREAUTH_MAX_KEYS`; `AUTH_RATE_LIMIT_MAX` still scales the OTP verify tiers. No new storage, no proxy/nginx change.
Known trade-off: an attacker can lock a victim out of password login (20 failures/h on the account bucket) from many addresses; mitigated by the per-hour window with progressive lockout only after repeated abuse, the per-address tier (a single attacker address cannot do it alone), and the fact that the login second step and password reset are separate buckets. The same applies to OTP verify, whose per-code attempt lock already had this property.

## Optional shared store (flag OFF by default)
`RATE_LIMIT_STORE=postgres` moves the strict tiers (auth, OTP-verify, AI, upload, payment, withdrawal) to table `rate_limit_counters`. Migration `prisma/migrations/20261018060000_rate_limit_counter/` (UNLOGGED, idempotent, rollback refuses while live counters exist) is **NOT EXECUTED**; verified only on the isolated DB `qa_iso_t6` (`src/utils/rate-limit-store.pg.test.ts`: atomic increment under 25 concurrent callers, window expiry, two limiter instances share one limit, migration x2, rollback guard). Browse/write stay in memory (a DB write per page view costs more than it protects). The store fails open (logs) if the DB errors. Needed only if the API ever runs as more than one process/container; with one container memory is exact. Alternative: Redis store (new service: not added).

## Server verification (read-only, owner/team)
1. `docker ps --format '{{.Names}} {{.Ports}}'` and `docker compose ps`: confirm exactly ONE api container (else memory counters multiply by N).
2. `docker network inspect <network> | grep -E 'Subnet|Gateway'`: nginx reaches the app from the gateway; must be inside `10/8`, `172.16/12` or `192.168/16` (else set `TRUST_PROXY=<gateway>/32`).
3. `grep -nE 'proxy_set_header|limit_req|limit_conn|real_ip|set_real_ip_from' /etc/nginx/sites-enabled/*` : must show `X-Forwarded-For $proxy_add_x_forwarded_for` (NOT `$http_x_forwarded_for`), and list any `limit_req` (a second limiter layer that would also answer 429 with no Retry-After). If Cloudflare or another proxy is in front, `req.ip` is that proxy unless `set_real_ip_from`/`real_ip_header` is configured: then every user shares one address.
4. `ss -ltnp | grep -E ':5009|:5010'`: the API port must listen on 127.0.0.1 only, not 0.0.0.0 (the code comment says it is also published directly).
5. `docker logs <api> 2>&1 | grep -i 'ERR_ERL'`: express-rate-limit prints validation errors (permissive trust proxy / unexpected X-Forwarded-For) once at start.
6. From the VPS: `curl -sI https://dev.waseetai.com/api/health | grep -i ratelimit` (public, harmless) to read the standard headers; run it from two networks and compare the reported client buckets only if you add a debug log (not done).
## Proposals (NOT applied)
- nginx: add `limit_req_zone $binary_remote_addr zone=api:10m rate=30r/s;` + `limit_req zone=api burst=60 nodelay;` as a coarse flood guard in front (answer with 429 + `Retry-After`), keep `client_max_body_size`; bind the container port to 127.0.0.1 only (`"127.0.0.1:${VPS_API_PORT}:5009"`).
- Set `TRUST_PROXY` explicitly in the server `.env` once step 2 is known.
- Redis or the Postgres store only if a second API container is planned.
