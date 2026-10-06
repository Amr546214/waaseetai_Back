import rateLimit, { ipKeyGenerator } from 'express-rate-limit';
import dotenv from 'dotenv';
import type { Request, Response, NextFunction } from 'express';
import { AppError } from '../utils/app-error';
import { formatWaitArabic, otpSendThrottle, otpThrottleMessage } from '../utils/otp-send-throttle';

dotenv.config();

// Parses a positive-integer env override, falling back to a safe default for
// anything missing/invalid so this can never be accidentally disabled (e.g. via 0 or NaN).
const positiveIntEnv = (value: string | undefined, fallback: number): number => {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

const AUTH_RATE_LIMIT_WINDOW_MS = positiveIntEnv(process.env.AUTH_RATE_LIMIT_WINDOW_MS, 60 * 60 * 1000); // default: 1 hour
const AUTH_RATE_LIMIT_MAX = positiveIntEnv(process.env.AUTH_RATE_LIMIT_MAX, 10); // default: 10 attempts per window

// Local/DEV-only bypass for QA: rate limiting stays ON (production-safe
// default) unless RATE_LIMIT_ENABLED is explicitly set to the literal string
// 'false'. Missing, 'true', or any other value keeps existing behavior
// unchanged, so this can never weaken production by default.
const RATE_LIMIT_ENABLED = process.env.RATE_LIMIT_ENABLED !== 'false';
const skipWhenRateLimitDisabled = () => !RATE_LIMIT_ENABLED;


/**
 * Builds the Arabic 429 with a `Retry-After` header (seconds) read from the limiter's reset time, so the app can show the
 * real wait instead of guessing it from the message text.
 */
const rateLimited = (req: Request, res: Response, prefix: string): AppError => {
  const resetTime = (req as Request & { rateLimit?: { resetTime?: Date } }).rateLimit?.resetTime;
  const seconds = resetTime ? Math.max(1, Math.ceil((resetTime.getTime() - Date.now()) / 1000)) : 60;
  res.setHeader('Retry-After', String(seconds));
  return new AppError(`${prefix} ${formatWaitArabic(seconds)}`, 429, [{ code: 'RATE_LIMITED', retryAfterSeconds: seconds }]);
};

// Standard rate limiter for API endpoints
export const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100, // Limit each IP to 100 requests per `window` (here, per 15 minutes)
  standardHeaders: true, // Return rate limit info in the `RateLimit-*` headers
  legacyHeaders: false, // Disable the `X-RateLimit-*` headers
  skip: skipWhenRateLimitDisabled,
  handler: (req, res, next) => {
    next(rateLimited(req, res, 'طلبات كثيرة من هذا الجهاز، حاول مرة أخرى بعد'));
  }
});

// Stricter rate limiter for sensitive Auth endpoints (Login, Register, OTP).
// Configurable via AUTH_RATE_LIMIT_WINDOW_MS / AUTH_RATE_LIMIT_MAX for dev/QA testing;
// defaults stay at the production-safe 10 attempts/hour if those env vars are unset.
export const authLimiter = rateLimit({
  windowMs: AUTH_RATE_LIMIT_WINDOW_MS,
  max: AUTH_RATE_LIMIT_MAX,
  standardHeaders: true,
  legacyHeaders: false,
  skip: skipWhenRateLimitDisabled,
  handler: (req, res, next) => {
    next(rateLimited(req, res, 'محاولات كثيرة، حاول مرة أخرى بعد'));
  }
});

export const aiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  skip: skipWhenRateLimitDisabled,
  handler: (req, res, next) => {
    next(new AppError('تم تجاوز الحد المسموح لطلبات الذكاء الاصطناعي، يرجى المحاولة لاحقاً', 429));
  }
});

/**
 * Limiter for the endpoints that SEND a code by email (register, resend-otp, forgot-password): per recipient (1 per 60 s,
 * 5 per hour) and per IP (30 per hour). Separate from `authLimiter`, so wrong passwords or verification attempts never block
 * sending, and sending never blocks verifying. `recipient` picks what identifies the recipient in the request.
 */
export const otpSendLimiter = (recipient: (req: Request) => string | undefined) =>
  (req: Request, res: Response, next: NextFunction) => {
    if (!RATE_LIMIT_ENABLED) return next();
    const key = recipient(req);
    // Without a usable recipient the schema validation answers the 400 (this runs before it, so just let it through).
    if (!key) return next();
    const result = otpSendThrottle.consume(key, req.ip);
    if (result.allowed) return next();
    res.setHeader('Retry-After', String(result.retryAfterSeconds));
    return next(new AppError(otpThrottleMessage(result.reason!, result.retryAfterSeconds), 429, [
      { code: 'OTP_RATE_LIMITED', reason: result.reason, retryAfterSeconds: result.retryAfterSeconds }
    ]));
  };

/** Lower-cased, trimmed identifier (email / user id) so differently-written forms of the same account share one bucket. */
export const normalizeOtpIdentifier = (value: unknown): string | undefined => {
  if (typeof value !== 'string') return undefined;
  const v = value.trim().toLowerCase();
  return v || undefined;
};

/** Bucket key of the OTP-verification limiter: the client address AND the normalised identifier. */
export const otpVerifyKey = (ip: string | undefined, identifier: string | undefined): string => `${ipKeyGenerator(ip || '0.0.0.0')}|${identifier ?? '-'}`;

/**
 * Limiters for the endpoints that VERIFY a code (verify-otp, verify-reset-code, reset-password). Mounted AFTER the schema validation, so
 * malformed requests never reach them, and keyed by IP + normalised identifier, so a third party cannot lock another user out by
 * hammering that user's email/userId from a different address. Successful requests are not counted (`skipSuccessfulRequests`). A
 * second, looser per-IP bucket stops one address from cycling through identifiers. The per-code attempt lock (5 guesses) is the
 * real brute-force defence; these only bound the request volume.
 */
export const otpVerifyLimiters = (identifier: (req: Request) => unknown) => [
  rateLimit({
    windowMs: AUTH_RATE_LIMIT_WINDOW_MS,
    max: AUTH_RATE_LIMIT_MAX,
    standardHeaders: true,
    legacyHeaders: false,
    skipSuccessfulRequests: true,
    skip: skipWhenRateLimitDisabled,
    validate: { keyGeneratorIpFallback: false }, // the key is built with ipKeyGenerator() inside otpVerifyKey()
    keyGenerator: (req) => otpVerifyKey(req.ip, normalizeOtpIdentifier(identifier(req))),
    handler: (req, res, next) => { next(rateLimited(req, res, 'محاولات كثيرة، حاول مرة أخرى بعد')); }
  }),
  rateLimit({
    windowMs: AUTH_RATE_LIMIT_WINDOW_MS,
    max: AUTH_RATE_LIMIT_MAX * 5,
    standardHeaders: true,
    legacyHeaders: false,
    skipSuccessfulRequests: true,
    skip: skipWhenRateLimitDisabled,
    validate: { keyGeneratorIpFallback: false },
    keyGenerator: (req) => ipKeyGenerator(req.ip || '0.0.0.0'),
    handler: (req, res, next) => { next(rateLimited(req, res, 'محاولات كثيرة، حاول مرة أخرى بعد')); }
  })
];
