import { Router } from 'express';
import { systemSettingsService } from '../services/system-settings.service';
import { geoSuggestion } from '../services/geo-suggestion.service';
import { cameThroughTrustedProxy, trustedClientIp } from '../utils/client-ip';
import { publicPlatformState } from '../services/platform-state';

const router = Router();

// Public, read-only, whitelisted keys only (see SETTING_DEFS.public). No auth by design.
router.get('/settings', async (_req, res, next) => {
	try {
		res.set('Cache-Control', 'no-store'); // same freshness as the server-side settings cache: a registration / banner change must not linger
		const s = await systemSettingsService.publicSnapshot(); if(!s.trusted) return res.status(503).json({success:false,code:'PLATFORM_STATE_UNAVAILABLE',message:'تعذر قراءة إعدادات المنصة بعد التشغيل.'}); res.json({ success: true, data: s.data, revision: s.revision });
	} catch (e) { next(e); }
});

// Light, never cached: what the browser reads when the site opens, after a reconnect, when the tab regains focus and as the fallback poll. Secret-free.
router.get('/platform-state', async (_req, res, next) => {
	try { res.set('Cache-Control', 'no-store'); res.json({ success: true, data: await publicPlatformState() }); } catch (e) { next(e); }
});

// Approximate country/city hint for the first registration (see services/geo-suggestion). Per-visitor, never cached by shared caches.
router.get('/geo-suggestion', async (req, res, next) => {
	try { res.set('Cache-Control', 'private, no-store'); res.json({ success: true, data: await geoSuggestion(trustedClientIp(req), req.headers as Record<string, unknown>, process.env, fetch, cameThroughTrustedProxy(req)) }); } catch (e) { next(e); }
});

export default router;
