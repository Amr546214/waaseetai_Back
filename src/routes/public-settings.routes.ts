import { Router } from 'express';
import { platformSettingsService } from '../services/platform-settings.service';

const router = Router();

// Public, read-only, whitelisted keys only (see SETTING_DEFS.public). No auth by design.
router.get('/settings', async (_req, res, next) => {
	try {
		res.set('Cache-Control', 'public, max-age=60');
		res.json({ success: true, data: await platformSettingsService.getPublic() });
	} catch (e) { next(e); }
});

export default router;
