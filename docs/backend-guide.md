# Backend guide

Reference material moved out of the repository README: features, roles, structure, data model, auth, API conventions, security and known limitations. Setup, scripts and deployment entry points live in the [README](../README.md); production deployment is in [DEPLOYMENT.md](../DEPLOYMENT.md).

> Paths are relative to the repository root. Statements here describe what the code does on the default branch; work in unmerged pull requests is not covered.

## Main Implemented Features

The following are implemented in the current codebase (not aspirational):

- **Authentication**: email/password registration with OTP email verification, login, Google OAuth sign-in/sign-up, password reset via OTP, session tracking with revocation.
- **Multi-role accounts**: a single user identity can hold and switch between CLIENT, PROVIDER, and AFFILIATE roles (see [User Roles](#user-roles--role-architecture)).
- **Client request & proposal flow**: clients post service requests; providers submit proposals; AI-assisted proposal review and matching are available (see [AI-Related Functionality](#ai-related-functionality)).
- **Projects, contracts & escrow**: project lifecycle from proposal acceptance through contract signing, staged deliveries, and escrow-backed payment release.
- **Marketplace**: a service catalog with packages/pricing, shopping cart, checkout, coupons, and order history.
- **Payments**: wallet top-up through PayPal (USD); marketplace purchases are paid from the wallet. All amounts are USD.
- **Provider tooling**: provider profile management, skills/portfolio, specialty verification, a points/level gamification system, provider-side finance (wallet, withdrawals) and coupons.
- **Client tooling**: client profile and finance views, request management, dashboards.
- **Disputes, ratings & reviews**: dispute lifecycle for projects, provider/client ratings.
- **Notifications**: in-app notifications; email delivery is implemented, SMS delivery is not (see [Known Limitations](#known-limitations)).
- **Real-time chat**: Socket.IO-based messaging between clients and providers.
- **Specialty verification & accreditation**: skill tests and accreditation submissions with AI-assisted grading/review.
- **Affiliate/marketing program**: referral tracking, commission logs, and an affiliate dashboard.
- **Admin operations**: administrative endpoints for disputes, withdrawals, onboarding review, accreditation review, specialty management, and user management.
- **Newsletter subscription**: a simple public subscribe/unsubscribe endpoint.

## User Roles & Role Architecture

Identity is modeled as a single `User` record that can own multiple roles:

- **`accountType`** — the account type chosen at signup (e.g. `CLIENT_INDIVIDUAL`, `PROVIDER_COMPANY`, `MARKETING_BROKER`). This reflects how the account was originally created.
- **`roles[]`** — the set of roles a user actually owns. A user can hold more than one (e.g. both CLIENT and PROVIDER).
- **`activeRole`** — which role the user is currently operating as. Most reads (profile, dashboard, progression) resolve their data from the currently active role, not from `accountType`.

**Self-service roles**: `CLIENT`, `PROVIDER`, and `AFFILIATE` can be added to an account and switched between by the authenticated user themselves.

**Internal/operator roles**: `ADMIN` and `SUPER_ADMIN` are not obtainable through any self-service endpoint. They are provisioned out-of-band (e.g. via the admin seed script) and are validated against explicitly wherever administrative access is required.

Each self-service role has its own profile record (`ClientProfile`, `ProviderProfile`, `AffiliateProfile`) with role-specific display and progression fields, so switching roles changes what a user sees without losing their other role's data.

## Project Structure

```
prisma/                  Prisma schema, migrations, and seed scripts
scripts/                 One-off/maintenance scripts (audits, backfills) and container entrypoint scripts
src/
  app.ts                 Express app assembly: middleware, route mounting, OpenAPI generation, HTTP server bootstrap
  socket.ts               Socket.IO server setup and namespace wiring
  config/                Database client, logger, and OpenAPI document generation
  routes/                Express routers, grouped by domain (some domains use a subfolder, e.g. auth/, dashboard/, profile/)
  controllers/            Request/response handling per domain
  services/               Business logic per domain (the largest layer)
  repositories/           Data-access layer for a small number of domains (auth, profile)
  middlewares/            Auth, validation, rate limiting, and error handling
  dtos/                   Zod request/response schemas
  sockets/                Socket.IO gateway handlers (chat, AI assistant, accreditation, assessments, etc.)
  modules/ai-review/      Self-contained AI review module (routes + controller + service + prompt)
  prompts/                AI prompt templates used by AI-related services
  utils/                  Shared helpers (error types, calculators, cloud storage, etc.)
  types/                  Shared/augmented TypeScript type declarations
```

Test files live alongside the code they test (e.g. `foo.service.ts` next to `foo.service.test.ts`) rather than in a separate test tree.

## Database Overview

The schema is defined in a single `prisma/schema.prisma` file and covers roughly a dozen functional domains. This section describes the domains and how they relate — see the schema file itself for exact fields.

- **Identity & accounts**: `User` is the central identity record (contact info, `accountType`, `roles[]`, `activeRole`, wallet balance). `UserSession` tracks issued sessions for revocation. `OtpVerification` backs email OTP flows.
- **Role profiles**: `ClientProfile`, `ProviderProfile`, and `AffiliateProfile` each belong to a `User` and hold role-specific data (company info, KYC/verification fields, banking details for payouts, display fields, and role-specific progression).
- **Provider capability & gamification**: `Skill`, `PortfolioItem`, `Education`, `Certificate`, `ProviderSpecialty`, `SpecialtyTest`/`TestSubmission`, `AssessmentAttempt`, and accreditation-related models (`AccreditationSample`, `AccreditationSubmission`, related proof/audit-log models) track a provider's verified skills. `ProviderGamification` and `PointTransaction` track a level/points system.
- **Client requests & proposals**: `ClientRequest` (a client's posted need) relates to `Proposal`/`ProjectProposal` (provider offers) and their attachments/milestones.
- **Projects & contracts**: `Project` is the working engagement between a client and provider, with `Contract`, `ProjectStage`, `StageDelivery`, and `Escrow` modeling staged, escrow-backed delivery and payment.
- **Marketplace**: `ServiceCatalog` (published service packages) with `ServiceStage`, `Cart`/`CartItem`, `Order`/`OrderItem`, `Coupon`/`CouponRedemption`, and `MarketplaceFavorite`.
- **Trust & safety**: `Dispute`, `Review` (ratings), `Withdrawal` (provider payouts), `WalletTransaction`, and `AccountAuditLog` (a unified audit trail for account-level events).
- **Communication**: `Conversation`/`Message` (chat) and `Notification`.
- **Affiliate program**: `AffiliateProfile` relates to `Referral`, `CommissionLog`, `AffiliateChannelHandle`/`AffiliateChannelMetric`, and `ReferralCustomLink`.
- **Taxonomy**: `Category` and `Specialty` classify services and provider expertise.
- **Newsletter**: `NewsletterSubscriber`, independent of the `User` model (subscription is not tied to having an account).

Relationships generally follow: a `User` owns zero or more role profiles → a `ClientRequest` or `ServiceCatalog` entry originates from those profiles → proposals/orders connect a client and a provider → an accepted engagement becomes a `Project`/`Contract` with its own escrow and delivery tracking.

Migrations are tracked in `prisma/migrations/`. No database records, sample data, or real identifiers are reproduced in this README — inspect the schema directly for full field-level detail.

## Authentication & Authorization

- **Token-based sessions**: on login/registration, the API issues a JWT. Requests authenticate via an `Authorization: Bearer <token>` header, with a cookie-based fallback.
- **Server-side session validation**: unlike a stateless-only JWT setup, each token is checked against a `UserSession` record in the database, so sessions can be revoked (e.g. on logout or from a "manage sessions" view) rather than remaining valid until expiry no matter what.
- **Role-based authorization**: route-level middleware checks a user's `accountType`/`roles[]`/`activeRole` against the roles a given endpoint requires, with equivalence rules for the multi-role model described above.
- **Real-time auth**: Socket.IO namespaces perform the same JWT + session validation as REST requests before allowing a connection.
- **Password handling**: passwords are hashed with `bcrypt`; they are never logged or returned in API responses.
- **Rate limiting**: authentication endpoints (login, registration, OTP, password reset) have a dedicated, stricter rate limit than general API traffic.

This section describes the authorization *model*; it intentionally does not enumerate specific historical findings or implementation edge cases — see [Security Notes](#security-notes) and [Known Limitations](#known-limitations) for how that information is handled.

## API Architecture

- All routers are mounted centrally in `src/app.ts`, grouped by domain (auth, profile, dashboard, provider, client, marketplace, admin, etc.).
- Most route groups are mounted under both an `/api/...` prefix and an unprefixed path. This exists to support two deployment shapes without duplicating route files (a reverse proxy in front of the API may or may not strip an `/api` prefix depending on environment) — for local development, use the `/api/...` prefixed paths.
- Health checks are available, unauthenticated, at `GET /health` and `GET /api/health` (both answer without touching the database).
- **API documentation is auto-generated, not hand-written.** After all routers are mounted, the app introspects the live Express router stack and builds an OpenAPI document from the actual registered routes. This is served as:
  - Raw JSON: `GET /api/openapi.json` (and `/openapi.json`)
  - Interactive Swagger UI: `GET /api/docs` (and `/docs`)

  Because the document reflects the running app, it stays in sync with route changes automatically, but request/response schema detail is only as rich as what the generator can infer — always cross-check against the relevant DTO/controller for exact request shapes.
- Response conventions follow a consistent `{ success, data }` / `{ success, message }` shape across most endpoints, with a centralized error-handling middleware.

## Security Notes

- **Secrets management**: all secrets (JWT signing key, OTP secret, database credentials, third-party API keys) are supplied exclusively through environment variables and must never be committed to source control or written into documentation.
- **Password storage**: hashed with `bcrypt`; plaintext passwords are never persisted or logged.
- **Session revocation**: authentication tokens are validated against a server-side session record, allowing sessions to be invalidated rather than remaining valid for their full lifetime unconditionally.
- **Role-based access control**: endpoints are gated by role/account-type checks appropriate to the sensitivity of the data or action; internal roles (ADMIN/SUPER_ADMIN) are not reachable through any self-service flow.
- **Transport & header hardening**: `helmet` is used for standard security headers, and CORS is restricted to an explicit allowlist of origins plus any origins configured via environment variables.
- **Rate limiting**: general API traffic and authentication endpoints are both rate-limited, with a stricter limit on authentication.
- **Development-only flags**: at least one environment flag (`ALLOW_TEST_CHECKOUT_WITHOUT_BALANCE`) exists purely to ease local/manual testing of the checkout flow. It must remain unset (or `false`) outside local development — treat any environment where it might be enabled as non-production.
- Security-relevant implementation details beyond this overview (e.g. specific validation edge cases or hardening decisions) are intentionally not catalogued here; consult the relevant source files or the team's internal tracking for that level of detail.

## Development Guidelines

- Follow the existing layering: put business logic in `services/`, keep `controllers/` thin (request parsing + calling a service + shaping the response), and use `routes/` only for wiring middleware and handlers together.
- Validate all external input with a Zod schema in `dtos/` (or an adjacent `*.schema.ts` file) rather than validating ad hoc inside a controller or service.
- Add a colocated `*.test.ts` file next to any service, controller, route, or utility you add or change non-trivially; keep tests independent of a real database (mock the Prisma client and other I/O).
- Keep TypeScript strict-mode clean — `tsconfig.json` has `strict: true`; avoid introducing `any` where a real type is available.
- When adding a new role-aware read (profile, dashboard, etc.), resolve fields from the user's currently **active** role rather than their original `accountType`, consistent with the existing pattern in `src/utils/role-display-resolver.ts` and related services.
- Run `npm run build` and `npm test` before opening a change for review.

## AI-related functionality

AI features go through an in-house LLM layer (`src/services/llm`, provider chosen by `LLM_PROVIDER` — `gemini` or `waseet` — plus `LLM_API_KEY` and `LLM_MODEL`; if any is missing the in-house AI features answer `503 NOT_CONFIGURED`) and a WaseetAI gateway client (`src/services/ai/waseet-ai`, enabled with `WASEET_AI_GATEWAY_ENABLED`) used by the authenticated help assistant (Socket.IO gateway and a text-to-speech route). Related code: `src/sockets/*gateway.ts`, `src/modules/ai-review/`, `src/prompts/`. Nothing here reads a secret from the frontend, and every AI path degrades gracefully when unconfigured.

Most of the platform (CRUD, marketplace, payments, chat transport, dashboards) is conventional application code. See [waseetai-ai-features-dev-status-2026-10-02.md](waseetai-ai-features-dev-status-2026-10-02.md) for a dated status snapshot and [waseetai-vendor-blockers.md](waseetai-vendor-blockers.md) for open vendor contracts. At least one dashboard metric (a match score next to AI-matched projects) is a static placeholder, not a live score.

## Environment variables

[`.env.example`](../.env.example) is the authoritative list (local) and [`.env.production.example`](../.env.production.example) the VPS template; both contain placeholders only. Groups: server and database (`PORT`, `DATABASE_URL`, `RUN_DB_*`), auth (`JWT_SECRET`, `OTP_SECRET`, rate-limit variables), CORS/frontend (`FRONTEND_URL`, `CORS_ORIGINS`), PayPal (`PAYPAL_*`), SMTP (`SMTP_*`), LLM and WaseetAI gateway (`LLM_*`, `WASEET_AI_*`), seeding (`SEED_ADMIN_*`) and feature flags that default to off (`PAYOUT_AUTOMATION_ENABLED`, `AFFILIATE_COMMISSION_ENGINE_ENABLED`). `CLOUDINARY_*` and `GOOGLE_CLIENT_ID` are read by the code and listed only in the production template; add them to your local `.env` when you use uploads or Google sign-in. Never commit `.env`.

## Known limitations

- **Fresh-database migrations are not safe.** `prisma/migrations` cannot be replayed on an empty database because later migrations reference objects missing from the initial one. New databases are created with `prisma db push`; `RUN_DB_MIGRATIONS` is only for databases whose migration history is already the source of truth. See [DEPLOYMENT.md](../DEPLOYMENT.md).
- **SMS delivery is not implemented.** `SMS_*` configuration exists, but the code path only logs; email (OTP, password reset) is sent through SMTP.
- **No automated integration/E2E layer.** `npm test` runs against mocked dependencies; `db:seed:e2e` only prepares data for manual scenarios.
- **Some endpoints intentionally answer "not implemented"** for account-type/tab combinations without dedicated logic.
- **Wallet deposits are PayPal-only (USD).** Other rails are not part of the default branch.
