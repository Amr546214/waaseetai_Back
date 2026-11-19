import { Router } from 'express';
import { publicAiLimiter } from '../middlewares/rate-limit.middleware';
import { askPublicAssistant } from '../services/ai/public-assistant.service';

// POST /api/public-assistant/ask — NO authentication on purpose (the signed-out introductory assistant). Guarded by the strict per-address tier
// (publicAiLimiter), strict input validation (question 400 chars, 4 history turns) and a daily ceiling on model calls. It never reads account data.
const router = Router();
router.post('/ask', publicAiLimiter, async (req, res, next) => {
	try { res.status(200).json({ success: true, data: await askPublicAssistant(req.body) }); } catch (error) { next(error); }
});
export default router;
