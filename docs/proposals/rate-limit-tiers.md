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
| login / register / reset (authLimiter) | 10 / h / IP | unchanged 10 / h / IP (env AUTH_RATE_LIMIT_*) | trusted IP | memory or postgres |
| OTP verify | 10 / h per IP+identifier, 50 / h per IP | unchanged | IP+identifier / IP | memory or postgres |
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
