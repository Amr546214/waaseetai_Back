import rateLimit from 'express-rate-limit';
import dotenv from 'dotenv';
import { AppError } from '../utils/app-error';

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

// Standard rate limiter for API endpoints
export const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100, // Limit each IP to 100 requests per `window` (here, per 15 minutes)
  standardHeaders: true, // Return rate limit info in the `RateLimit-*` headers
  legacyHeaders: false, // Disable the `X-RateLimit-*` headers
  skip: skipWhenRateLimitDisabled,
  handler: (req, res, next) => {
    next(new AppError('Too many requests from this IP, please try again after 15 minutes', 429));
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
    next(new AppError('Too many authentication attempts, please try again after an hour', 429));
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
