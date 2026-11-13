import { Router } from 'express';
import { systemSettingsService } from '../services/system-settings.service';
import { publicPlatformState } from '../services/platform-state';

const router = Router();

// Public, read-only, whitelisted keys only (see SETTING_DEFS.public). No auth by design.
router.get('/settings', async (_req, res, next) => {
	try {
		res.set('Cache-Control', 'public, max-age=5'); // same freshness as the server-side settings cache: a registration / banner change must not linger
		res.json({ success: true, data: await systemSettingsService.publicValues() });
	} catch (e) { next(e); }
});

// Light, never cached: what the browser reads when the site opens, after a reconnect, when the tab regains focus and as the fallback poll. Secret-free.
router.get('/platform-state', async (_req, res, next) => {
	try { res.set('Cache-Control', 'no-store'); res.json({ success: true, data: await publicPlatformState() }); } catch (e) { next(e); }
});

export default router;
