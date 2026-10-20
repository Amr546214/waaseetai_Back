import rateLimit, { ipKeyGenerator } from 'express-rate-limit';
import dotenv from 'dotenv';
import type { Request, Response, NextFunction, RequestHandler } from 'express';
import { AppError } from '../utils/app-error';
import { clientIpKey, identityKey, verifiedUserId } from '../utils/rate-limit-identity';
import { createStrictStore } from '../utils/rate-limit-store';
import { BoundedRateLimitStore } from '../utils/bounded-rate-limit-store';
import { AccountDelayGuard } from '../utils/account-delay-guard';
import { RecognisedOrigins, originKey } from '../utils/recognised-origins';
import { formatWaitArabic, otpSendThrottle, otpThrottleMessage, resendAvailableAtIso } from '../utils/otp-send-throttle';

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
    const result = otpSendThrottle.reserve(key, req.ip);
    if (!result.allowed) {
      res.setHeader('Retry-After', String(result.retryAfterSeconds));
      return next(new AppError(otpThrottleMessage(result.reason!, result.retryAfterSeconds), 429, [
        { code: 'OTP_RATE_LIMITED', reason: result.reason, retryAfterSeconds: result.retryAfterSeconds }
      ]));
    }
    // A send that really went out also says when the next one is allowed (additive field, top level and in `data`; old apps ignore it).
    const sendJson = typeof res.json === 'function' ? res.json.bind(res) : null;
    if (sendJson) res.json = ((body?: unknown) => {
      if (res.locals.otpEmailSent === true && body && typeof body === 'object' && !Array.isArray(body)) {
        const at = resendAvailableAtIso();
        const b = body as Record<string, unknown>;
        body = { ...b, resendAvailableAt: at, ...(b.data && typeof b.data === 'object' ? { data: { ...(b.data as object), resendAvailableAt: at } } : {}) };
      }
      return sendJson(body);
    }) as typeof res.json;
    // reserve() took the per-IP slot at once (concurrent requests from one address cannot all pass while mail is in flight): keep it for an attempt that reached the
    // mailer, give it back for one that failed earlier (409, validation, crash); the recipient cooldown starts only for a delivered mail.
    res.once('finish', () => {
      if (res.locals.otpEmailAttempted === true) otpSendThrottle.commitRecipient(key, res.locals.otpEmailSent === true);
      else otpSendThrottle.releaseIp(req.ip);
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

/** Cap of live keys per pre-authentication limiter (identifier keys come from the request body; see BoundedRateLimitStore). */
const PREAUTH_MAX_KEYS = positiveIntEnv(process.env.RL_PREAUTH_MAX_KEYS, 20_000);
const HOUR = 60 * 60 * 1000;

/** Longest identifier we key on; longer values are not valid emails / uuids and fall back to the per-address limiters only. */
const IDENTIFIER_MAX_LENGTH = 254;
/** Normalised identifier for limiter keys: trimmed, lower-cased, bounded. Nothing is looked up, so existing and unknown accounts get identical treatment. */
export const limiterIdentifier = (value: unknown): string | undefined => {
  const v = normalizeOtpIdentifier(value);
  return v && v.length <= IDENTIFIER_MAX_LENGTH ? v : undefined;
};

interface PreAuthBucketSpec {
  name: string;
  tier: string;
  limit: number;
  windowMs?: number;
  /** progressive lockout cap in windows (1 = none) */
  maxMultiplier?: number;
  /** true = every request counts (flood guard); false = only responses with status >= 400 count */
  countAll?: boolean;
  /** return undefined to skip this bucket for the request (no usable identifier) */
  key: (req: Request) => string | undefined;
}

/**
 * One pre-authentication bucket. The counter is raised BEFORE the handler runs (so concurrent guesses cannot slip past) and, unless
 * `countAll`, handed back when the response is a success; failed attempts (status >= 400) keep it. Bounded in-memory store by default,
 * the shared postgres store when RATE_LIMIT_STORE=postgres.
 */
const preAuthBucket = (spec: PreAuthBucketSpec): RequestHandler => {
  const store = createStrictStore(spec.name) ?? new BoundedRateLimitStore({ limit: spec.limit, maxKeys: PREAUTH_MAX_KEYS, maxMultiplier: spec.maxMultiplier ?? 1 });
  return rateLimit({
    windowMs: spec.windowMs ?? HOUR,
    limit: spec.limit,
    standardHeaders: true,
    legacyHeaders: false,
    skipSuccessfulRequests: !spec.countAll,
    validate: { keyGeneratorIpFallback: false },
    passOnStoreError: true,
    store,
    keyGenerator: (req) => spec.key(req) as string,
    skip: (req) => !RATE_LIMIT_ENABLED || spec.key(req) === undefined,
    handler: (req, res, next) => { next(rateLimited(req, res, 'محاولات كثيرة، حاول مرة أخرى بعد', spec.tier)); }
  });
};

const idKey = (identifier: (req: Request) => unknown) => (req: Request) => limiterIdentifier(identifier(req));

/** Numbers of the pre-authentication tiers (env override RL_*; reasoning in docs/proposals/rate-limit-tiers.md). */
export const PREAUTH = {
  // login (password): failed attempts
  LOGIN_ID_IP: positiveIntEnv(process.env.RL_LOGIN_ID_IP, 6),     // one account from one address
  // one account from ALL addresses: NOT a lockout any more. Unrecognised origins get LOGIN_FREE attempts per 24 h, then a growing gap (base .. ceiling)
  LOGIN_FREE: positiveIntEnv(process.env.RL_LOGIN_FREE, 10),
  LOGIN_DELAY_BASE_MS: positiveIntEnv(process.env.RL_LOGIN_DELAY_BASE_MS, 30_000),
  LOGIN_DELAY_MAX_MS: positiveIntEnv(process.env.RL_LOGIN_DELAY_MAX_MS, 900_000),
  LOGIN_RECOGNISED_MS: positiveIntEnv(process.env.RL_LOGIN_RECOGNISED_HOURS, 14 * 24) * HOUR,
  LOGIN_IP: positiveIntEnv(process.env.RL_LOGIN_IP, 60),          // one address across ALL accounts (credential spraying)
  LOGIN_IP_ALL: positiveIntEnv(process.env.RL_LOGIN_IP_ALL, 300), // one address, every request incl. successes (flood guard)
  // second login step (code sent at login) and Google sign-in
  STEP_ID_IP: positiveIntEnv(process.env.RL_LOGIN_STEP_ID_IP, 10),
  STEP_ID: positiveIntEnv(process.env.RL_LOGIN_STEP_ID, 30),
  STEP_IP: positiveIntEnv(process.env.RL_LOGIN_STEP_IP, 60),
  // OTP verify (verify-otp, verify-reset-code, reset-password)
  OTPV_ID_IP: AUTH_RATE_LIMIT_MAX,                                // unchanged (10)
  OTPV_IP: AUTH_RATE_LIMIT_MAX * 5,                               // unchanged (50)
  OTPV_ID: positiveIntEnv(process.env.RL_OTPV_ID, AUTH_RATE_LIMIT_MAX * 3) // new: one account from all addresses
} as const;

/** Recognition / delay state of the password-login account layer (per process; see utils/account-delay-guard.ts and recognised-origins.ts). */
export const accountDelay = new AccountDelayGuard({ free: PREAUTH.LOGIN_FREE, baseMs: PREAUTH.LOGIN_DELAY_BASE_MS, ceilingMs: PREAUTH.LOGIN_DELAY_MAX_MS, maxKeys: PREAUTH_MAX_KEYS });
export const recognisedOrigins = new RecognisedOrigins({ ttlMs: PREAUTH.LOGIN_RECOGNISED_MS, maxAccounts: PREAUTH_MAX_KEYS, maxPending: PREAUTH_MAX_KEYS });
const originOf = (req: Request) => originKey(clientIpKey(req), req.get?.('user-agent') ?? (req.headers?.['user-agent'] as string | undefined));

/**
 * Per-account layer of password login. Recognised origins (a completed login within RL_LOGIN_RECOGNISED_HOURS, default 14 days) skip it. Any
 * other origin is admitted with the growing gap of AccountDelayGuard; a request inside the gap gets the standard 429 (tier login_account,
 * Retry-After = remaining gap) and changes nothing. Nothing is looked up, so an unknown e-mail sees exactly the same gap as a real one.
 */
const accountDelayGate = (idOf: (req: Request) => string | undefined): RequestHandler => (req, res, next) => {
  if (!RATE_LIMIT_ENABLED) return next();
  const id = idOf(req);
  if (!id || recognisedOrigins.has(id, originOf(req))) return next();
  const r = accountDelay.admit(id);
  if (!r.allowed) {
    const seconds = Math.max(1, Math.ceil(r.retryAfterMs / 1000));
    res.setHeader('Retry-After', String(seconds));
    return next(new AppError(`محاولات كثيرة، حاول مرة أخرى بعد ${formatWaitArabic(seconds)}`, 429, [{ code: 'RATE_LIMITED', tier: 'login_account', retryAfterSeconds: seconds }]));
  }
  res.once('finish', () => { if (res.statusCode < 400) accountDelay.refund(id); });
  return next();
};

/** Password step answered 200 (challenge issued): remember userId -> (account, origin) briefly, so a later verify-otp success can recognise the origin. */
const loginChallengeLink = (idOf: (req: Request) => string | undefined): RequestHandler => (req, res, next) => {
  const id = idOf(req);
  if (RATE_LIMIT_ENABLED && id) {
    const json = res.json.bind(res);
    res.json = ((body: any) => {
      const userId = body?.data?.userId;
      if (res.statusCode < 400 && typeof userId === 'string' && userId) recognisedOrigins.noteChallenge(userId.toLowerCase(), id, originOf(req));
      return json(body);
    }) as typeof res.json;
  }
  next();
};

/** Second login step (verify-otp only, not resend) that ends in success from the origin that passed the password step: recognise it. */
const loginStepRecognition: RequestHandler = (req, res, next) => {
  if (RATE_LIMIT_ENABLED && /\/login\/verify-otp\/?$/.test(req.path || req.originalUrl || '')) {
    const userId = limiterIdentifier(req.body?.userId);
    if (userId) res.once('finish', () => { if (res.statusCode < 400) recognisedOrigins.confirm(userId, originOf(req)); });
  }
  next();
};

/**
 * Login family limiters. `identifier` = getter of the (validated) email / userId in the body; undefined = address-only buckets.
 * Order matters: address buckets first, so a flood of invented identifiers from one address is cut before it creates identifier keys.
 *  1. every request per address (flood guard, counts successes too)
 *  2. failures per address across all accounts (spraying ceiling)
 *  3. failures per account + address (guessing one account from one place)
 *  4. password login: per account from ALL addresses = progressive DELAY for unrecognised origins only (accountDelayGate, never a lock);
 *     login steps: failures per userId from all addresses, progressive lockout (the userId is only known after a correct password)
 * Nothing here reads the database, so a known and an unknown identifier see the same counters and the same 429.
 */
export const loginLimiters = (identifier: (req: Request) => unknown, prefix: 'login' | 'login_step' | 'google' = 'login'): RequestHandler[] => {
  const idOf = idKey(identifier);
  const ip = (req: Request) => clientIpKey(req);
  const pw = prefix === 'login';
  const n = { ip: pw ? PREAUTH.LOGIN_IP : PREAUTH.STEP_IP, idIp: pw ? PREAUTH.LOGIN_ID_IP : PREAUTH.STEP_ID_IP, id: PREAUTH.STEP_ID };
  return [
    preAuthBucket({ name: `${prefix}:ipall`, tier: `${prefix}_ip_flood`, limit: PREAUTH.LOGIN_IP_ALL, countAll: true, key: ip }),
    preAuthBucket({ name: `${prefix}:ip`, tier: `${prefix}_ip`, limit: n.ip, maxMultiplier: 4, key: ip }),
    preAuthBucket({ name: `${prefix}:idip`, tier: `${prefix}_account_ip`, limit: n.idIp, maxMultiplier: 4, key: (req) => { const id = idOf(req); return id ? `${ip(req)}|${id}` : undefined; } }),
    ...(pw
      ? [loginChallengeLink(idOf), accountDelayGate(idOf)]
      : [
        preAuthBucket({ name: `${prefix}:id`, tier: `${prefix}_account`, limit: n.id, maxMultiplier: 8, key: idOf }),
        ...(prefix === 'login_step' ? [loginStepRecognition] : [])
      ])
  ];
};

/**
 * Limiters for the endpoints that VERIFY a code (verify-otp, verify-reset-code, reset-password). Mounted AFTER the schema validation, so
 * malformed requests never reach them. Failures only (`skipSuccessfulRequests`):
 *  - per address across identifiers (50 / h, unchanged) stops one address cycling through accounts;
 *  - per address + normalised identifier (10 / h, unchanged) so a third party cannot lock another user out from a different address;
 *  - NEW per identifier across ALL addresses (30 / h, progressive lockout) bounds distributed guessing against one account.
 * The per-code attempt lock (5 guesses) is the real brute-force defence and is untouched; these only bound the request volume.
 */
export const otpVerifyLimiters = (identifier: (req: Request) => unknown) => {
  const idOf = idKey(identifier);
  return [
    preAuthBucket({ name: 'otpv:ip', tier: 'otp_verify_ip', limit: PREAUTH.OTPV_IP, key: (req) => clientIpKey(req) }),
    preAuthBucket({ name: 'otpv:id', tier: 'otp_verify_account_ip', limit: PREAUTH.OTPV_ID_IP, maxMultiplier: 4, key: (req) => { const id = idOf(req); return id ? otpVerifyKey(req.ip, id) : undefined; } }),
    preAuthBucket({ name: 'otpv:acct', tier: 'otp_verify_account', limit: PREAUTH.OTPV_ID, maxMultiplier: 8, key: idOf })
  ];
};

/** Numbers of the authenticated account-security routes (env override RL_*; reasoning in docs/proposals/rate-limit-tiers.md). */
export const ACCOUNT = {
  PWD_FAIL_USER: positiveIntEnv(process.env.RL_PWD_FAIL_USER, 5),        // wrong current password etc., per ACCOUNT per hour (strict: a stolen session must not guess it)
  PWD_ALL_USER: positiveIntEnv(process.env.RL_PWD_ALL_USER, 10),         // every password-change request per account per hour
  PWD_FAIL_NET: positiveIntEnv(process.env.RL_PWD_FAIL_NET, 40),         // failures per address across accounts (an office), authenticated traffic
  PWD_FAIL_ANON: positiveIntEnv(process.env.RL_PWD_FAIL_ANON, 10),       // no verified token: per address, as before
  SESSIONS_USER: positiveIntEnv(process.env.RL_SESSIONS_USER, 60),       // sessions revoke / own-profile edits per account per hour
  SESSIONS_NET: positiveIntEnv(process.env.RL_SESSIONS_NET, 300),
  SESSIONS_ANON: positiveIntEnv(process.env.RL_SESSIONS_ANON, 10)
} as const;

const accountKey = (req: Request) => { const u = verifiedUserId(req); return u ? `u:${u}` : undefined; };
const netKey = (req: Request) => (verifiedUserId(req) ? clientIpKey(req) : undefined);
const anonKey = (req: Request) => (verifiedUserId(req) ? undefined : clientIpKey(req));

/**
 * Authenticated password change (provider/identity PUT /password, client POST /password-change-request) — replaces the 10 / h / address
 * `authLimiter`. Strict PER ACCOUNT (the current password is verified here): 5 failures / h and 10 requests / h per verified account id, so a
 * stolen session cannot guess it, while other accounts behind the same address are unaffected; 40 failures / h per address across
 * accounts as a net; a request without a verified token keeps 10 failures / h per address (authenticate answers 401 anyway).
 */
export const passwordChangeLimiter: RequestHandler = chain([
  preAuthBucket({ name: 'pwdchg:all', tier: 'password_change', limit: ACCOUNT.PWD_ALL_USER, countAll: true, key: accountKey }),
  preAuthBucket({ name: 'pwdchg:fail', tier: 'password_change_failed', limit: ACCOUNT.PWD_FAIL_USER, key: accountKey }),
  preAuthBucket({ name: 'pwdchg:net', tier: 'password_change_ip', limit: ACCOUNT.PWD_FAIL_NET, key: netKey }),
  preAuthBucket({ name: 'pwdchg:anon', tier: 'password_change_ip', limit: ACCOUNT.PWD_FAIL_ANON, key: anonKey })
]);

/** Authenticated account housekeeping (revoke sessions, edit own account details): per account, a generous net per address. */
export const accountActionLimiter: RequestHandler = chain([
  preAuthBucket({ name: 'acctact:user', tier: 'account_action', limit: ACCOUNT.SESSIONS_USER, countAll: true, key: accountKey }),
  preAuthBucket({ name: 'acctact:net', tier: 'account_action_ip', limit: ACCOUNT.SESSIONS_NET, countAll: true, key: netKey }),
  preAuthBucket({ name: 'acctact:anon', tier: 'account_action_ip', limit: ACCOUNT.SESSIONS_ANON, countAll: true, key: anonKey })
]);
