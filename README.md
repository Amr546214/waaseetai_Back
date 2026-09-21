# Waseet AI — Backend

Backend API for **Waseet AI**, a marketplace platform connecting clients with independent service providers, plus a marketing/affiliate program. Built with Node.js, TypeScript, Express, and PostgreSQL (via Prisma), with selected AI-assisted features (provider/project matching, specialty accreditation review, proposal analysis) layered on top of a conventional REST + WebSocket backend.

This README covers **local development**. For production/VPS deployment, see [`DEPLOYMENT.md`](./DEPLOYMENT.md).

## Table of Contents

- [Architecture Overview](#architecture-overview)
- [Technology Stack](#technology-stack)
- [Main Implemented Features](#main-implemented-features)
- [User Roles & Role Architecture](#user-roles--role-architecture)
- [Project Structure](#project-structure)
- [Database Overview](#database-overview)
- [Authentication & Authorization](#authentication--authorization)
- [API Architecture](#api-architecture)
- [AI-Related Functionality](#ai-related-functionality)
- [Local Development Requirements](#local-development-requirements)
- [Installation](#installation)
- [Environment Setup](#environment-setup)
- [Database Setup](#database-setup)
- [Running the Project Locally](#running-the-project-locally)
- [Available npm Scripts](#available-npm-scripts)
- [Testing](#testing)
- [Docker / Local Containers](#docker--local-containers)
- [Security Notes](#security-notes)
- [Development Guidelines](#development-guidelines)
- [Known Limitations](#known-limitations)

## Architecture Overview

The backend is a single Express application organized in layers:

```
Routes  →  Controllers  →  Services  →  (Repositories, for a few domains)  →  Prisma  →  PostgreSQL
```

- **Routes** (`src/routes/**`) define endpoints, attach middleware (auth, validation, rate limiting), and delegate to controllers.
- **Controllers** (`src/controllers/**`) handle HTTP request/response concerns and call into services.
- **Services** (`src/services/**`) contain business logic and are the primary place domain rules live. Most services talk to Prisma directly; a small number of domains (auth, profile) additionally use a **repository** layer for data access.
- **Prisma** is the single ORM/data-access layer over PostgreSQL, defined in one schema file.
- A **Socket.IO** layer (`src/socket.ts` + `src/sockets/**`) provides real-time features alongside the REST API, reusing the same JWT-based authentication.
- Request-level validation is done with **Zod** schemas (`src/dtos/**`, plus per-route schema files), applied via shared validation middleware.
- An **OpenAPI document is generated at startup** by introspecting the live Express router (see [API Architecture](#api-architecture)) — it is not hand-maintained.

## Technology Stack

| Concern | Technology |
|---|---|
| Language | TypeScript (Node.js 22) |
| HTTP framework | Express 5 |
| Database | PostgreSQL |
| ORM | Prisma 7 (`@prisma/client` with the `pg` driver adapter) |
| Real-time | Socket.IO 4 |
| Validation | Zod |
| Authentication | JSON Web Tokens (`jsonwebtoken`) + `bcrypt` password hashing |
| Rate limiting | `express-rate-limit` |
| HTTP hardening | `helmet`, `cors` |
| Logging | `winston` (application logs) + `morgan` (HTTP access logs) |
| File storage | Cloudinary (uploads: avatars, documents, portfolio media) |
| Email | Nodemailer over SMTP |
| Payments | Moyasar (card / Apple Pay / STC Pay — Saudi payment gateway) |
| AI | OpenAI SDK |
| API docs | `swagger-ui-express`, backed by a self-generated OpenAPI document |
| Testing | Node.js built-in test runner (`node:test`) via `tsx` |
| Containerization | Docker + Docker Compose |

## Main Implemented Features

The following are implemented in the current codebase (not aspirational):

- **Authentication**: email/password registration with OTP email verification, login, Google OAuth sign-in/sign-up, password reset via OTP, session tracking with revocation.
- **Multi-role accounts**: a single user identity can hold and switch between CLIENT, PROVIDER, and AFFILIATE roles (see [User Roles](#user-roles--role-architecture)).
- **Client request & proposal flow**: clients post service requests; providers submit proposals; AI-assisted proposal review and matching are available (see [AI-Related Functionality](#ai-related-functionality)).
- **Projects, contracts & escrow**: project lifecycle from proposal acceptance through contract signing, staged deliveries, and escrow-backed payment release.
- **Marketplace**: a service catalog with packages/pricing, shopping cart, checkout, coupons, and order history.
- **Payments**: real integration with the Moyasar payment gateway for marketplace checkout.
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
- Health checks are available, unauthenticated, at `GET /health` and `GET /api/health`.
- **API documentation is auto-generated, not hand-written.** After all routers are mounted, the app introspects the live Express router stack and builds an OpenAPI document from the actual registered routes. This is served as:
  - Raw JSON: `GET /api/openapi.json` (and `/openapi.json`)
  - Interactive Swagger UI: `GET /api/docs` (and `/docs`)

  Because the document reflects the running app, it stays in sync with route changes automatically, but request/response schema detail is only as rich as what the generator can infer — always cross-check against the relevant DTO/controller for exact request shapes.
- Response conventions follow a consistent `{ success, data }` / `{ success, message }` shape across most endpoints, with a centralized error-handling middleware.

## AI-Related Functionality

The project uses the OpenAI SDK for several **real, implemented** features:

- **Provider–project matching**: an AI matching engine scores and ranks candidate projects for a provider based on their profile, skills, and history.
- **Specialty accreditation review**: AI-assisted evaluation of accreditation submissions and work samples.
- **Assessment generation & grading**: specialty test questions and scoring assistance for provider skill verification.
- **Proposal review**: AI-assisted analysis of proposals submitted against a client request.
- **AI assistant chat**: a real-time, Socket.IO-based conversational assistant.
- **Marketplace listing review**: AI-assisted checks as part of publishing a service catalog entry.

**What is not AI-powered**: the platform is not "fully AI-driven" — most CRUD, marketplace, payment, chat transport, and dashboard logic is conventional application code. At least one dashboard metric (a match-score value shown alongside AI-matched projects on a summary view) is currently a static placeholder rather than a live AI score; this is noted here so it isn't mistaken for a second matching system.

All AI functionality requires a valid `OPENAI_API_KEY` (see [Environment Setup](#environment-setup)) and will fail gracefully or be unavailable without one.

## Local Development Requirements

- Node.js 22.x (matches the version used in `Dockerfile`)
- npm
- PostgreSQL (local install, or run via the provided Docker Compose setup)
- A Cloudinary account (for file upload features) — optional if you're not exercising upload flows
- An OpenAI API key — optional if you're not exercising AI features
- A Moyasar test account — optional if you're not exercising checkout/payment flows

## Installation

```bash
git clone <this-repository>
cd waseetai-backend
npm install
```

## Environment Setup

Copy the example file and fill in your own values — **never commit `.env`, and never paste real secrets into documentation, code comments, or commit messages**:

```bash
cp .env.example .env
```

Variable names you may need to configure, grouped by purpose (see `.env.example` for the authoritative reference file; some names below are used by the application but not yet present in that file — add them if you enable the corresponding feature):

**Server**
```
PORT
NODE_ENV
API_PUBLIC_URL
API_VERSION
```

**Database**
```
DATABASE_URL
DB_HOST
DB_PORT
POSTGRES_DB
POSTGRES_USER
POSTGRES_PASSWORD
RUN_DB_MIGRATIONS
RUN_DB_PUSH
RUN_DB_PUSH_ACCEPT_DATA_LOSS
```

**Authentication & Sessions**
```
JWT_SECRET
OTP_SECRET
AUTH_RATE_LIMIT_WINDOW_MS
AUTH_RATE_LIMIT_MAX
```

**CORS / Frontend**
```
FRONTEND_URL
CORS_ORIGINS
```

**Google OAuth**
```
GOOGLE_CLIENT_ID
```

**Payments (Moyasar)**
```
MOYASAR_PUBLISHABLE_KEY
MOYASAR_SECRET_KEY
```

**AI (OpenAI)**
```
OPENAI_API_KEY
```

**File Storage (Cloudinary)**
```
CLOUDINARY_CLOUD_NAME
CLOUDINARY_API_KEY
CLOUDINARY_API_SECRET
```

**Email (SMTP)**
```
SMTP_HOST
SMTP_PORT
SMTP_SECURE
SMTP_USER
SMTP_PASS
SMTP_FROM
EMAIL_SENDER_NAME
OTP_EMAIL_SUBJECT
RESET_PASSWORD_EMAIL_SUBJECT
```

**SMS** (configuration exists; delivery is not implemented — see [Known Limitations](#known-limitations))
```
SMS_ENABLED
SMS_PROVIDER
SMS_SENDER_ID
```

**Admin & Seeding**
```
SEED_ADMIN_EMAIL
SEED_ADMIN_PASSWORD
SEED_E2E
SEED_LOCAL_CHAT
```

**Development/testing-only flags** — use `YOUR_VALUE`-style placeholders locally; never enable these in a production environment:
```
ALLOW_TEST_CHECKOUT_WITHOUT_BALANCE
BACKFILL_DRY_RUN
```

Use placeholders such as `YOUR_DATABASE_URL`, `YOUR_JWT_SECRET`, `YOUR_OPENAI_API_KEY`, etc. when filling in `.env` locally — real values should come only from your own local secrets, never from documentation or shared examples.

## Database Setup

With `DATABASE_URL` pointing at a running PostgreSQL instance:

```bash
# Generate the Prisma client (required after install and after schema changes)
npm run prisma:generate

# Apply the tracked migration history to a fresh database
npm run db:migrate
```

Seed data:

```bash
npm run db:seed              # base seed (e.g. an initial admin account, from SEED_ADMIN_* env vars)
npm run db:seed:e2e          # additional data for end-to-end scenarios
npm run seed:taxonomy        # marketplace category/specialty taxonomy
```

`npm run db:studio` opens Prisma Studio for browsing/editing local data through a GUI.

> Note: the containerized entrypoint used by Docker Compose defaults to synchronizing the schema with `prisma db push` rather than `migrate deploy` (see `RUN_DB_PUSH` / `RUN_DB_MIGRATIONS` above). For everyday local development against your own database, `npm run db:migrate` is the more conventional path.

## Running the Project Locally

```bash
npm start
```

This runs the TypeScript source directly via `nodemon` + `tsx`, restarting on file changes. By default the server listens on the port set by `PORT` (falls back to `5009`) and prints its local URL on startup.

Verify it's running:

```bash
curl http://localhost:5009/health
```

For a production-style run (compiled output):

```bash
npm run build
npm run start:prod
```

## Available npm Scripts

| Script | Purpose |
|---|---|
| `npm start` | Run the API in development mode (`nodemon` + `tsx`, auto-restart) |
| `npm run build` | Compile TypeScript to `dist/` |
| `npm run start:prod` | Run the compiled build (`dist/app.js`) |
| `npm test` | Run the automated test suite |
| `npm run prisma:generate` | Generate the Prisma client from the schema |
| `npm run db:migrate` | Apply Prisma migrations in development mode |
| `npm run prisma:deploy` / `npm run prisma:migrate:deploy` | Apply migrations without prompting (deploy-style) |
| `npm run db:studio` | Open Prisma Studio |
| `npm run db:seed` | Run the base seed script |
| `npm run db:seed:e2e` | Run the end-to-end test data seed |
| `npm run seed:taxonomy` | Seed marketplace category/specialty taxonomy |
| `npm run audit:existing` | Run a repository maintenance/audit script (see `scripts/`) |
| `npm run backfill:role-profiles` | One-off backfill script for the multi-role profile system |
| `npm run backfill:role-profile-fields` | One-off backfill script for role-specific profile fields |

## Testing

Tests use Node.js's **built-in test runner** (`node:test`) executed through `tsx`, not Jest or Vitest. Run the full suite with:

```bash
npm test
```

- Test files are colocated with the source they cover (e.g. `src/services/auth.service.ts` and `src/services/auth.service.test.ts`), spanning services, controllers, routes, DTOs, middlewares, and shared utilities.
- Tests run against **mocked dependencies**, not a real database — Node's experimental module-mocking support (`--experimental-test-module-mocks`, already configured in the `test` script) is used to substitute the Prisma client and other I/O boundaries. No test in this suite requires a running PostgreSQL instance.
- There is currently no separate integration or end-to-end test layer running against a live database as part of `npm test`; `db:seed:e2e` prepares data for manual/exploratory E2E scenarios rather than an automated E2E suite.

## Docker / Local Containers

A `Dockerfile` (multi-stage: development, build, production) and `compose.yaml` are provided for running the API alongside PostgreSQL in containers.

```bash
docker compose up -d --build
docker compose logs -f api
```

This starts:
- **`postgres`** — PostgreSQL 16, with a health check and a named volume for data persistence.
- **`api`** — the backend, built from the production stage of the `Dockerfile`, waiting for the database to be healthy before starting.

Configuration (database name/user/password, exposed port, etc.) is supplied via your local `.env` file, referenced by `compose.yaml` — see [Environment Setup](#environment-setup). This setup is intended for local development and testing; production deployment details are covered separately in [`DEPLOYMENT.md`](./DEPLOYMENT.md).

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

## Known Limitations

This section reflects the current development status, not a security audit:

- **SMS delivery is not implemented.** The configuration surface (`SMS_ENABLED`, `SMS_PROVIDER`, `SMS_SENDER_ID`) exists, but the code path that would send an SMS currently only logs a warning; no message is actually sent. Email delivery (OTP, password reset) is fully implemented via SMTP.
- **No automated integration/E2E test layer.** The test suite (`npm test`) runs entirely against mocked dependencies; there is no CI-integrated suite that exercises the API against a real database end-to-end.
- **One dashboard AI-match score is a placeholder.** A summary metric on a dashboard view currently returns a static value rather than a live score, separate from the real AI matching engine described in [AI-Related Functionality](#ai-related-functionality).
- **A few endpoints intentionally return "not implemented"** for account-type/tab combinations that don't yet have dedicated logic (e.g. certain generic profile-tab updates, and dashboard statistics for roles that have their own dedicated dashboard endpoints instead).
- **Migration history vs. schema sync**: the containerized entrypoint defaults to `prisma db push` rather than replaying the full migration history, for reasons documented in-code (`scripts/docker-entrypoint.sh`). New local development databases are unaffected if you use `npm run db:migrate` directly.

If you find additional gaps or security-relevant issues while working in this codebase, track and discuss them through the team's normal process rather than expanding this section into a detailed technical write-up.
