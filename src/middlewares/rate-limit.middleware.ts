import rateLimit, { ipKeyGenerator } from 'express-rate-limit';
import dotenv from 'dotenv';
import type { Request, Response, NextFunction, RequestHandler } from 'express';
import { AppError } from '../utils/app-error';
import { clientIpKey, identityKey, verifiedUserId } from '../utils/rate-limit-identity';
import { createStrictStore } from '../utils/rate-limit-store';
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
 * real wait instead of guessing it from the message text. The body carries the machine code `RATE_LIMITED` (+ the tier that tripped).
 */
const rateLimited = (req: Request, res: Response, prefix: string, tier?: string): AppError => {
  const resetTime = (req as Request & { rateLimit?: { resetTime?: Date } }).rateLimit?.resetTime;
  const seconds = resetTime ? Math.max(1, Math.ceil((resetTime.getTime() - Date.now()) / 1000)) : 60;
  res.setHeader('Retry-After', String(seconds));
  return new AppError(`${prefix} ${formatWaitArabic(seconds)}`, 429, [{ code: 'RATE_LIMITED', ...(tier ? { tier } : {}), retryAfterSeconds: seconds }]);
};

/**
 * TIERS. Every number is a per-window cap and can be overridden by env (RL_<TIER>_<FIELD>); the defaults come from the measured
 * navigation session in docs/proposals/rate-limit-tiers.md. `user` = per verified account, `ip` = unauthenticated client address,
 * `ipNet` = safety net per address for ALL traffic of authenticated users (an office / QA machine with several accounts).
 */
export interface TierConfig { windowMs: number; user: number; ip: number; ipNet: number }
const MIN15 = 15 * 60 * 1000;
const tierFromEnv = (name: string, base: TierConfig): TierConfig => ({
  windowMs: positiveIntEnv(process.env[`RL_${name}_WINDOW_MS`], base.windowMs),
  user: positiveIntEnv(process.env[`RL_${name}_USER`], base.user),
  ip: positiveIntEnv(process.env[`RL_${name}_IP`], base.ip),
  ipNet: positiveIntEnv(process.env[`RL_${name}_IP_NET`], base.ipNet)
});
export const TIERS = {
  // normal reads (GET/HEAD): layout, guards, statistics, lists, details
  BROWSE: tierFromEnv('BROWSE', { windowMs: MIN15, user: 900, ip: 300, ipNet: 4500 }),
  // normal writes (POST/PUT/PATCH/DELETE) that are not in a stricter tier
  WRITE: tierFromEnv('WRITE', { windowMs: MIN15, user: 240, ip: 120, ipNet: 1200 }),
  // GET /provider/statistics and friends: every dashboard page loads them
  DASHBOARD: tierFromEnv('DASHBOARD', { windowMs: MIN15, user: 300, ip: 300, ipNet: 1500 }),
  // endpoints that call a language model
  AI: tierFromEnv('AI', { windowMs: MIN15, user: 30, ip: 30, ipNet: 150 }),
  // file uploads (multipart): memory + cloud storage cost
  UPLOAD: tierFromEnv('UPLOAD', { windowMs: MIN15, user: 40, ip: 20, ipNet: 200 }),
  // money in: PayPal order create / capture, escrow deposit, funding
  PAYMENT: tierFromEnv('PAYMENT', { windowMs: MIN15, user: 20, ip: 10, ipNet: 100 }),
  // money out: withdrawal requests
  WITHDRAWAL: tierFromEnv('WITHDRAWAL', { windowMs: 60 * 60 * 1000, user: 10, ip: 5, ipNet: 50 }),
  // PayPal webhook: signature-verified, from PayPal's addresses only
  WEBHOOK: tierFromEnv('WEBHOOK', { windowMs: MIN15, user: 1200, ip: 1200, ipNet: 1200 })
} as const;

/**
 * One tier = (1) a bucket per identity — the verified account id when the request carries a valid token, else the trusted client address
 * (IPv6 collapsed to /56) — and (2) for authenticated traffic a looser per-address safety net, so one machine cannot spread abuse over many
 * accounts, while several honest accounts behind one address do not block each other. Keyed by account id, never by token / session /
 * role: refreshing the token or switching role keeps the same bucket. Strict tiers use the shared store when RATE_LIMIT_STORE=postgres.
 */
const buildTier = (name: string, cfg: TierConfig, message: string, opts: { shared?: boolean } = {}): RequestHandler[] => {
  const common = {
    windowMs: cfg.windowMs,
    standardHeaders: true as const,
    legacyHeaders: false as const,
    validate: { keyGeneratorIpFallback: false },
    passOnStoreError: true
  };
  const identity = rateLimit({
    ...common,
    skip: skipWhenRateLimitDisabled,
    limit: (req: Request) => (verifiedUserId(req) ? cfg.user : cfg.ip),
    keyGenerator: (req: Request) => identityKey(req),
    ...(opts.shared ? { store: createStrictStore(`${name}:id`) } : {}),
    handler: (req, res, next) => { next(rateLimited(req, res, message, name)); }
  });
  const net = rateLimit({
    ...common,
    skip: (req: Request) => !RATE_LIMIT_ENABLED || !verifiedUserId(req),
    limit: cfg.ipNet,
    keyGenerator: (req: Request) => clientIpKey(req),
    ...(opts.shared ? { store: createStrictStore(`${name}:net`) } : {}),
    handler: (req, res, next) => { next(rateLimited(req, res, message, `${name}_ip`)); }
  });
  return [identity, net];
};

/** Runs middlewares in order; the first one that errors ends the chain. */
const chain = (handlers: RequestHandler[]): RequestHandler => (req, res, next) => {
  let i = 0;
  const step = (err?: unknown) => {
    if (err || i >= handlers.length) return next(err as any);
    const h = handlers[i++];
    try { h(req, res, step); } catch (e) { next(e); }
  };
  step();
};

const READ_METHODS = new Set(['GET', 'HEAD']);
const GLOBAL_DONE = Symbol.for('waseet.rateLimit.globalDone');
/** Paths the global tiers never count: container health probes (they come from the host, not a user). */
const UNCOUNTED_PATHS = /^\/(api\/)?health\/?$/;
const WEBHOOK_PATH = /^\/(api\/)?(webhooks?\/)?paypal[-/]?webhook/i;

const browseTier = chain(buildTier('browse', TIERS.BROWSE, 'طلبات كثيرة، حاول مرة أخرى بعد'));
const writeTier = chain(buildTier('write', TIERS.WRITE, 'طلبات كثيرة، حاول مرة أخرى بعد'));
const webhookTier = chain(buildTier('webhook', TIERS.WEBHOOK, 'طلبات كثيرة، حاول مرة أخرى بعد'));

/**
 * The global limiter (mounted once in app.ts; some public routes also name it, and the second pass is a no-op). Reads and writes have
 * separate budgets, so browsing can never use up what a form submission needs, and the other way round.
 */
export const apiLimiter: RequestHandler = (req, res, next) => {
  if ((res.locals as Record<symbol, unknown>)[GLOBAL_DONE]) return next();
  (res.locals as Record<symbol, unknown>)[GLOBAL_DONE] = true;
  const path = req.path || req.originalUrl || '';
  if (UNCOUNTED_PATHS.test(path)) return next();
  if (WEBHOOK_PATH.test(path)) return webhookTier(req, res, next);
  return (READ_METHODS.has(req.method) ? browseTier : writeTier)(req, res, next);
};

// Stricter rate limiter for sensitive Auth endpoints (Login, Register, OTP).
// Configurable via AUTH_RATE_LIMIT_WINDOW_MS / AUTH_RATE_LIMIT_MAX for dev/QA testing;
// defaults stay at the production-safe 10 attempts/hour if those env vars are unset. Always per client address (the caller is not yet known).
export const authLimiter = rateLimit({
  windowMs: AUTH_RATE_LIMIT_WINDOW_MS,
  limit: AUTH_RATE_LIMIT_MAX,
  standardHeaders: true,
  legacyHeaders: false,
  skip: skipWhenRateLimitDisabled,
  validate: { keyGeneratorIpFallback: false },
  keyGenerator: (req) => clientIpKey(req),
  passOnStoreError: true,
  store: createStrictStore('auth'),
  handler: (req, res, next) => {
    next(rateLimited(req, res, 'محاولات كثيرة، حاول مرة أخرى بعد', 'auth'));
  }
});

/**
 * Dashboard summary endpoints that EVERY dashboard page loads (the sidebar / overview call GET /provider/statistics on each navigation, twice on
 * some pages). They make no AI call, so they must not share the AI budget. Own counter, per account (per address when anonymous).
 */
export const dashboardLimiter: RequestHandler = chain(buildTier('dashboard', TIERS.DASHBOARD, 'طلبات كثيرة، حاول مرة أخرى بعد'));

/** AI-bound routes: strict, per account (30 / 15 min each), independent of browsing. */
export const aiLimiter: RequestHandler = chain(buildTier('ai', TIERS.AI, 'تم تجاوز الحد المسموح لطلبات الذكاء الاصطناعي، يرجى المحاولة لاحقاً بعد', { shared: true }));

/** Upload routes: mount BEFORE multer so a rejected request never buffers the file. */
export const uploadLimiter: RequestHandler = chain(buildTier('upload', TIERS.UPLOAD, 'عدد كبير من عمليات رفع الملفات، حاول مرة أخرى بعد', { shared: true }));

/** Money-in routes (PayPal order / capture, escrow deposit, funding authorisation). Never retried automatically by the app. */
export const paymentLimiter: RequestHandler = chain(buildTier('payment', TIERS.PAYMENT, 'محاولات دفع كثيرة، حاول مرة أخرى بعد', { shared: true }));

/** Withdrawal requests (money out). */
export const withdrawalLimiter: RequestHandler = chain(buildTier('withdrawal', TIERS.WITHDRAWAL, 'محاولات سحب كثيرة، حاول مرة أخرى بعد', { shared: true }));

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

/**
 * Like `otpSendLimiter`, for the endpoints whose cooldown must start only once a code was REALLY sent (register, resend-otp). It only checks
 * here; the controller reports what happened with `res.locals.otpEmailAttempted` (the mailer was called) and `res.locals.otpEmailSent`
 * (the SMTP server accepted it), and the attempt is recorded when the response finishes: the per-IP counter for any attempt that reached the
 * mailer, the recipient cooldown only for a delivered one. A request that failed earlier (409 duplicate, validation in the service, a crash)
 * records nothing, so the corrected retry is never answered with "we just sent you a code".
 */
export const otpSendGate = (recipient: (req: Request) => string | undefined) =>
  (req: Request, res: Response, next: NextFunction) => {
    if (!RATE_LIMIT_ENABLED) return next();
    const key = recipient(req);
    if (!key) return next();
    const result = otpSendThrottle.peek(key, req.ip);
    if (!result.allowed) {
      res.setHeader('Retry-After', String(result.retryAfterSeconds));
      return next(new AppError(otpThrottleMessage(result.reason!, result.retryAfterSeconds), 429, [
        { code: 'OTP_RATE_LIMITED', reason: result.reason, retryAfterSeconds: result.retryAfterSeconds }
      ]));
    }
    res.once('finish', () => {
      if (res.locals.otpEmailAttempted === true) otpSendThrottle.record(key, req.ip, res.locals.otpEmailSent === true);
    });
    return next();
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
    store: createStrictStore('otpv:id'),
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
    store: createStrictStore('otpv:ip'),
    validate: { keyGeneratorIpFallback: false },
    keyGenerator: (req) => clientIpKey(req),
    handler: (req, res, next) => { next(rateLimited(req, res, 'محاولات كثيرة، حاول مرة أخرى بعد')); }
  })
];
