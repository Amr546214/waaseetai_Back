import type { NextFunction, Request, Response } from 'express';
import { AppError } from '../utils/app-error';
import { clientIpKey } from '../utils/rate-limit-identity';
import { loginGuardService } from '../services/login-guard.service';
import { formatWaitArabic } from '../utils/otp-send-throttle';

export const LOGIN_BLOCKED_CODE = 'LOGIN_TEMPORARILY_BLOCKED';
const enabled = () => process.env.RATE_LIMIT_ENABLED !== 'false';

/**
 * Mounted on the password-login route BEFORE the controller. A blocked address(+account) is answered 429 with Retry-After and does NOT reach the password check (so a blocked
 * guesser learns nothing and the rejected request is not counted again). After the response: a 401 is a real credential failure and is counted; any success (< 400) clears the
 * address+account counter; every other outcome (validation 400, 429, 5xx) is ignored. The address is `req.ip` as derived from the configured trust-proxy boundary, never a header.
 */
export const loginGuardGate = (identifier: (req: Request) => unknown, guard = loginGuardService) => async (req: Request, res: Response, next: NextFunction) => {
	if (!enabled()) return next();
	const raw = identifier(req); const email = typeof raw === 'string' && raw.trim() ? raw.trim().toLowerCase().slice(0, 254) : undefined;
	const key = { ip: clientIpKey(req), email };
	const v = await guard.check(key);
	if (v.blocked) {
		res.setHeader('Retry-After', String(v.retryAfterSeconds));
		return next(new AppError(`محاولات دخول فاشلة كثيرة، حاول مرة أخرى بعد ${formatWaitArabic(v.retryAfterSeconds)}`, 429, [{ code: LOGIN_BLOCKED_CODE, scope: v.scope, retryAfterSeconds: v.retryAfterSeconds }]));
	}
	res.once('finish', () => { if (res.statusCode === 401) void guard.recordFailure(key); else if (res.statusCode < 400) void guard.recordSuccess(key); });
	next();
};
