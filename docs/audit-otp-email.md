# audit(otp-email): why the verification / reset code sometimes does not reach the inbox

Read-only audit, 2026-10-05 (backend `4ac0247`, frontend `04a9ed1`). No code changed, nothing deployed, no DB access, **no OTP or secret printed**. No test account with a readable mailbox was available, so no dev send test was run (see "What is not proven").

## 1. How each flow sends (backend)
| Flow | Endpoint | Rate limiter | Sends how | Failure visible to the caller? |
|---|---|---|---|---|
| Register | `POST /auth/register` | `authLimiter` | `createOtp(EMAIL, 5 min)`, then `notificationService.sendEmailOtp(...)` **not awaited**, `.catch` only logs | **No**: the HTTP answer is always `201 { userId }` |
| Login (account not verified) | `POST /auth/login` | `authLimiter` | `resendOtp(userId)`: **deletes the old codes**, creates a new one, sends (same fire-and-forget) and answers `verified:false` | No |
| Resend | `POST /auth/resend-otp` | `authLimiter` | same `resendOtp` | No (`200` even if SMTP failed) |
| Forgot password | `POST /auth/forgot-password` | `authLimiter` | `await sendPasswordResetEmail`, error swallowed on purpose (generic answer) | No |
| Verify / verify-reset-code / reset-password | `/auth/verify-otp`, `/verify-reset-code`, `/reset-password` | **same `authLimiter`** | n/a | n/a |
| Login OTP (users with `phoneOtpEnabled`) | `POST /auth/login/verify-otp`, `/login/resend-otp` | same | **SMS, not email**: `sendSmsOtp` returns without sending unless `SMS_ENABLED=true` + a provider (only a Twilio stub exists, "not implemented"); prod has no `SMS_ENABLED` | No |

Email transport: `mailTransporter` (nodemailer SMTP) -> **Titan** (`smtp.titan.email:465`, SSL), `from: support@waseetai.com`, same on dev and prod. No queue, no retry, no timeout settings, **the SMTP response (`accepted` / `rejected` / `response` id) is never logged**, only "OTP email sent to <address>" / "Failed to send OTP email". `EmailService.sendOtpEmail` (a second, apparently unused path) additionally logs the **OTP itself in clear text** when `SMTP_USER` is missing.

## 2. Observed behaviour (prod container logs, real attempts; addresses and IPs not recorded)
| Flow | Endpoint | Status | Email service called? | Provider response | UI message | Code received? |
|---|---|---|---|---|---|---|
| Register (7 attempts) | `POST /auth/register` | 201 x7 | yes, 7 x "OTP email sent" | accepted by Titan (no response body logged) | success | unknown (needs mailbox) |
| Register | `POST /auth/register` | **429** (05:07, 05:11) | **no** (blocked by the limiter before the controller) | none | Arabic 429 with wait (mapHttpError) | no email exists |
| Login (wrong password x4, then valid ones) | `POST /auth/login` | 401 x4 then **429** x4 | no | none | wrong-password / 429 message | n/a |
| Google login | `POST /auth/google` | **429** (05:00) | no | none | 429 message | n/a |
| **Forgot password** (2 attempts) | `POST /auth/forgot-password` | **429 x2** (05:55, 05:57) | **no** | none | 429 message (the reset code was never even attempted) | no email exists |
| Verify OTP (7) | `POST /auth/verify-otp` | 200 x7 | n/a | n/a | n/a | the 7 codes were received by whoever tested |
Dev and prod logs of the current containers (started today) contain no email lines at all; every retained container shows **0 "Failed to send" events** (sent: prod 7, dev 1-6 per container).

## 3. Causes, in priority order
1. **One shared 10-requests-per-hour limiter for the whole auth surface (backend, prod AND dev-by-default).** `authLimiter` (`middlewares/rate-limit.middleware.ts`) defaults to **10 requests / hour / IP** and is applied to register, login, verify-otp, resend-otp, forgot-password, verify-reset-code, reset-password, google, login/verify-otp and login/resend-otp **together**, and it counts **every** request including 401 wrong-password and successful ones. Prod has no `AUTH_RATE_LIMIT_*` override (dev has 1000/h). A normal test session (register + verify + logout + login + resend + a few typos) reaches 10 in minutes; from then on *every* auth call returns 429 **before any code is created or any email is sent**. The prod log above shows exactly this: forgot-password and register answered 429 while the same IP had just made 401 logins. The user experiences it as "the code never arrives". The IP is the real client IP (trust proxy is configured), so this is per user, not site-wide.
2. **Backend never tells the user an email failed (backend).** Register / resend / login-unverified answer 200/201 regardless of the SMTP result (fire-and-forget + `.catch` log; forgot-password swallows by design). The UI then shows "تم إرسال الرمز بنجاح" / "أرسلنا رمزًا إلى بريدك" even when nothing was sent. Failures are only a log line, and the log never contains the provider response, so "accepted by Titan" cannot be told apart from "queued and lost".
3. **Weak sender authentication on `waseetai.com` (email provider / DNS).** DNS shows SPF `v=spf1 include:spf.titan.email ~all` (ok) but **no DKIM record at the Titan selector (`titan._domainkey`) and no DMARC record (`_dmarc`)**. Mail accepted by Titan (all 7 prod sends were accepted) can still land in spam or be delayed/dropped by Gmail/Outlook. This is the likeliest reason for "the provider says sent but the code did not arrive". Needs DNS action, not code.
4. **Each resend invalidates the previous code (backend).** `resendOtp` calls `deleteUserOtps` before creating the new one, and login-while-unverified already sends one. Two quick sends (login + resend, or the 403 auto-send + the login send) mean the first email's code no longer works; if the older email arrives later the user types a dead code and sees "invalid".
5. **The activation email says "valid for 10 minutes" but the code lives 5 minutes (backend).** `getOtpEmailTemplate` (mail.transporter.ts) says 10 minutes; registration/resend use 5. (Reset codes really are 10.)
6. **Login OTP by SMS is not deliverable in prod (backend/config).** Any account with `phoneOtpEnabled` gets "رمز التحقق المرسل إلى جوالك" but `SMS_ENABLED` is unset and the Twilio sender is a stub, so no SMS exists. (Not email; reported because it is another "code never arrives".)
7. **Frontend:** the verify screen already dedupes the 403 auto-send (90 s) and locks resend after a 429 using the server wait; pending id is stored in cookie + localStorage and survives logout/login (the login response sets it again). Remaining frontend gaps: the unverified-login hand-off says "أرسلنا رمز تحقق" without any way to know it was sent; a 60 s countdown starts even when the backend already sent a code at login (so the user waits to resend a code that may never have arrived); the 429 text depends on the English server message ("an hour") being parseable.

## 4. Where the problem lives
- **Backend**: causes 1, 2, 4, 5, 6 (rate limiter design, silent failure, code invalidation, copy, SMS).
- **Email provider / DNS**: cause 3 (DKIM, DMARC).
- **Frontend**: only cause 7 (messaging); it is not the origin.
- **Dev vs prod**: the limiter bites **prod** (default 10/h); dev is set to 1000/h, so on dev the same problem would show only through causes 2-4. SMTP config is identical on both.

## 5. What is not proven
- No readable mailbox was available, so "Code received?" is unknown for every row, and the spam/bounce/suppression check on a real inbox was not done. The Titan side (mail log / bounces in the Titan panel) should be checked for the 7 prod sends.
- I could not run a dev send test: the instruction asked for an account and a readable address; none exists in the session (I will not use a third-party inbox).

## 6. Proposed PRs (not started)
**Backend**
1. Rate limiting: a **dedicated per-email + per-IP limiter for the OTP-sending endpoints** (resend-otp, forgot-password, login/resend-otp, e.g. 1 per 60 s and 5 per hour per email), and a more generous shared limiter for the rest (login with `skipSuccessfulRequests`, verify-otp with its own attempt counter, which already exists per code). 429 with an Arabic message and a `Retry-After` header.
2. Send result: await the send for register / resend / login-unverified (or record the result), log `messageId` + `accepted` / `rejected` + SMTP `response` code (never the code), and answer with `emailSent: true|false` so the UI can say "تعذر إرسال البريد" instead of success. Remove the clear-text OTP log in `EmailService`.
3. Do not invalidate a still-valid code on every resend (or return the same code within its validity), and fix the "10 minutes" copy (or the 5-minute expiry).
4. Optional: a small retry (1-2 times) on transient SMTP errors.
**Frontend**
5. Show the real outcome (`emailSent`), a clear 429 wait, and do not start a resend lock when nothing was sent.
**Ops (no PR)**
6. Add DKIM (Titan's `titan._domainkey` record from the Titan panel) and a DMARC record (`v=DMARC1; p=none; rua=...` to start) for `waseetai.com`; check the Titan sent/bounce log for the prod sends; decide the SMS provider for phone OTP or disable `phoneOtpEnabled`.

Decisions needed: the new limits (per email / per IP), whether the API may now return `emailSent` (small response change), and whether I should run a dev send test once you give me a mailbox I can read.
