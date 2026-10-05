import { Router } from 'express';
import { affiliatesPublicController } from '../controllers/affiliates-public.controller';
import { apiLimiter } from '../middlewares/rate-limit.middleware';

// Public, unauthenticated affiliate lookup — used during registration,
// BEFORE an account exists, so this cannot sit behind authenticate(). Only
// ever returns the minimal, PII-safe { id, referralSlug, displayName } shape
// (see affiliates-public.service.ts) — never email/phone/bank/IBAN/KYC/
// wallet/commission data.
//
// Rate-limit-conscious: same apiLimiter pattern already used for
// marketer-profile.routes.ts's GET /public/:id (another public, pre-auth
// endpoint) — no AI/Gemini cost here, so the plain apiLimiter is enough
// rather than the stricter authLimiter/aiLimiter.
const router = Router();

router.get('/resolve', apiLimiter, affiliatesPublicController.resolve);
router.get('/search', apiLimiter, affiliatesPublicController.search);
router.get('/referral-status', apiLimiter, affiliatesPublicController.referralStatus);
router.post('/referral-cookie/clear', apiLimiter, affiliatesPublicController.clearReferralCookie);

export default router;
