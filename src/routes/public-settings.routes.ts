import { Router } from 'express';
import { systemSettingsService } from '../services/system-settings.service';

const router = Router();

// Public, read-only, whitelisted keys only (see SETTING_DEFS.public). No auth by design.
router.get('/settings', async (_req, res, next) => {
	try {
		res.set('Cache-Control', 'public, max-age=5'); // same freshness as the server-side settings cache: a registration / banner change must not linger
		res.json({ success: true, data: await systemSettingsService.publicValues() });
	} catch (e) { next(e); }
});

export default router;
