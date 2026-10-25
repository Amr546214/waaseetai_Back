import type { NextFunction, Request, Response } from 'express';
import { systemSettingsService } from '../services/system-settings.service';

export const MAINTENANCE_CODE = 'MAINTENANCE';
/**
 * While `maintenanceMode` is on, every HTTP request answers 503 {code:'MAINTENANCE'} EXCEPT these (after the optional /api prefix):
 *  - /health, /auth (sign-in/out must keep working so the SUPER_ADMIN can get in), /public (the settings that carry the banner), /docs;
 *  - /admin (the console - each route still needs its permission; this is the SUPER_ADMIN's way to switch maintenance off);
 *  - /payments (incoming payment-provider callbacks and webhooks must never be refused by mistake), /socket.io;
 *  - /notifications (reading the notices that explain the stop).
 * Preflight (OPTIONS) always passes. If the setting cannot be read the request passes (fail-open): a settings outage must not become a platform outage.
 */
const EXEMPT = /^\/(?:api\/)?(?:health|auth|public|docs|admin|payments|notifications|socket\.io)(?:\/|$|\?)/;
export const isMaintenanceExempt = (path: string) => path === '/' || path === '/api' || EXEMPT.test(path);

export async function maintenanceMiddleware(req: Request, res: Response, next: NextFunction) {
	try {
		if (req.method === 'OPTIONS' || isMaintenanceExempt(req.path)) return next();
		if (!(await systemSettingsService.get<boolean>('maintenanceMode'))) return next();
		const text = String(await systemSettingsService.get<string>('maintenanceBannerText') || '').trim();
		res.set('Retry-After', '60');
		return res.status(503).json({ success: false, code: MAINTENANCE_CODE, message: text || 'المنصة في صيانة مؤقتة. سنعود قريبًا.' });
	} catch { return next(); }
}
