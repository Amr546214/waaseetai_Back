import type { NextFunction, Request, Response } from 'express';
import jwt from 'jsonwebtoken';
import { AccountType, UserStatus } from '@prisma/client';
import { prisma } from '../config/db';
import { logger } from '../config/logger';
import { getAuthCookie } from '../utils/request-cookie';
import { sessionService } from '../services/session.service';
import { systemSettingsService } from '../services/system-settings.service';

export const MAINTENANCE_CODE = 'MAINTENANCE';

/**
 * While `maintenanceMode` is on, every HTTP request answers 503 {code:'MAINTENANCE'} unless:
 *  (1) it carries a valid session of an ACTIVE SUPER_ADMIN (the whole platform and the admin console stay usable so they can review and fix; no other staff gets a blanket exception
 *      just for being ADMIN), or
 *  (2) it matches one of the EXPLICIT allowances below (method + path + purpose). New payment starts are NOT in the list: only what already exists may finish.
 * Reading the setting: the stored value; if the store cannot be read, the LAST KNOWN GOOD value (the failure is logged, never silently turned into "maintenance off"). A cold boot with no
 * trusted value yet follows MAINTENANCE_COLD_BOOT_POLICY (default `closed`: non-exempt traffic waits for the first successful read; health stays up).
 */
interface Allow { method: string; path: RegExp; purpose: string }
const P = (re: string) => new RegExp(`^/(?:api/)?${re}/?$`);
export const MAINTENANCE_ALLOW: readonly Allow[] = [
	{ method: 'GET', path: /^\/(?:api\/?)?$/, purpose: 'service probe' },
	{ method: 'GET', path: P('health'), purpose: 'liveness probe' },
	{ method: 'GET', path: P('public/settings'), purpose: 'banner + public settings (the maintenance notice itself)' },
	{ method: 'GET', path: /^\/(?:api\/)?docs(?:\/.*)?$/, purpose: 'API docs' },
	{ method: 'POST', path: P('payments/paypal/webhook'), purpose: 'inbound payment-provider callback: existing payments / payouts must be able to settle' },
	{ method: 'POST', path: P('client/finance/paypal/order/capture'), purpose: 'return path: completes an order the customer already approved at PayPal before maintenance (creating a NEW order is not allowed)' },
	{ method: 'POST', path: P('auth/login'), purpose: 'existing users sign in' },
	{ method: 'POST', path: P('auth/google'), purpose: 'existing Google users sign in' },
	{ method: 'POST', path: P('auth/login/verify-otp'), purpose: 'sign-in code' },
	{ method: 'POST', path: P('auth/login/resend-otp'), purpose: 'sign-in code' },
	{ method: 'POST', path: P('auth/verify-otp'), purpose: 'finish activation of an existing pending account' },
	{ method: 'POST', path: P('auth/resend-otp'), purpose: 'activation code for an existing pending account' },
	{ method: 'POST', path: P('auth/forgot-password'), purpose: 'recovery' },
	{ method: 'POST', path: P('auth/verify-reset-code'), purpose: 'recovery' },
	{ method: 'POST', path: P('auth/reset-password'), purpose: 'recovery' },
	{ method: 'POST', path: P('auth/logout'), purpose: 'sign out' },
	{ method: 'GET', path: P('auth/account-status'), purpose: 'the app learns why it cannot proceed' },
	{ method: 'GET', path: P('notifications'), purpose: 'the notices that explain the stop' },
	{ method: 'PATCH', path: /^\/(?:api\/)?notifications\/(?:read-all|[^/]+\/read)\/?$/, purpose: 'mark notices as read' },
	{ method: 'GET', path: /^\/(?:api\/)?socket\.io\/?.*$/, purpose: 'live connection handshake (every event is still authorised by its own gate)' },
	{ method: 'POST', path: /^\/(?:api\/)?socket\.io\/?.*$/, purpose: 'live connection transport' },
];
export const isMaintenanceAllowed = (method: string, path: string) => MAINTENANCE_ALLOW.some(a => a.method === method && a.path.test(path));

const SA_TTL_MS = 30_000;
const saCache = new Map<string, { ok: boolean; at: number }>();
/** A valid, unrevoked session of an ACTIVE SUPER_ADMIN account (the type is read from the database, never from the token). Cached 30 s per user. */
export async function isActiveSuperAdminRequest(req: Request): Promise<boolean> {
	try {
		const h = req.headers.authorization; const token = h && h.startsWith('Bearer ') ? h.split(' ')[1] : getAuthCookie(req);
		const secret = process.env.JWT_SECRET; if (!token || !secret) return false;
		const decoded = jwt.verify(token, secret) as { userId?: string };
		if (!decoded.userId || !(await sessionService.isActiveToken(token))) return false;
		const hit = saCache.get(decoded.userId); if (hit && Date.now() - hit.at < SA_TTL_MS) return hit.ok;
		const u = await prisma.user.findUnique({ where: { id: decoded.userId }, select: { accountType: true, status: true, isBanned: true } });
		const ok = !!u && u.accountType === AccountType.SUPER_ADMIN && u.status === UserStatus.ACTIVE && !u.isBanned;
		saCache.set(decoded.userId, { ok, at: Date.now() }); return ok;
	} catch { return false; }
}
export const resetMaintenanceCaches = () => saCache.clear();
const coldPolicy = () => (process.env.MAINTENANCE_COLD_BOOT_POLICY === 'open' ? 'open' : 'closed');

export async function maintenanceMiddleware(req: Request, res: Response, next: NextFunction) {
	try {
		if (req.method === 'OPTIONS' || isMaintenanceAllowed(req.method, req.path)) return next();
		const m = await systemSettingsService.getTrusted<boolean>('maintenanceMode');
		const on = m.trusted ? m.value === true : coldPolicy() === 'closed';
		if (!on) return next();
		if (await isActiveSuperAdminRequest(req)) return next();
		if (!m.trusted) logger.warn(`[Maintenance] no trusted value yet (cold boot): applying policy "${coldPolicy()}" to ${req.method} ${req.path}`);
		const text = m.trusted ? String(await systemSettingsService.get<string>('maintenanceBannerText') || '').trim() : '';
		res.set('Retry-After', '60');
		return res.status(503).json({ success: false, code: MAINTENANCE_CODE, message: text || (m.trusted ? 'المنصة في صيانة مؤقتة. سنعود قريبًا.' : 'المنصة تتحقق من حالتها بعد التشغيل. حاول بعد لحظات.') });
	} catch (e) { logger.error(`[Maintenance] gate failed (${(e as Error)?.message}); request let through only because no state could be established at all`); return next(); }
}
