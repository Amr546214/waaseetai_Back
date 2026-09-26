import { Router } from 'express';
import * as providerProfileController from '../controllers/provider-profile.controller';
import { authenticate, requireActiveUser } from '../middlewares/auth.middleware';
import { authorize } from '../middlewares/auth.middleware';
import { AccountType } from '@prisma/client';
import { memoryUpload, uploadMulterFile } from '../utils/cloudinary-storage';
import { authLimiter, aiLimiter } from '../middlewares/rate-limit.middleware';

const router = Router();
const documentUpload = memoryUpload({
	fileSize: 10 * 1024 * 1024,
	files: 1,
	allowedMimeTypes: new Set(['application/pdf', 'image/jpeg', 'image/png'])
});

// Route classification for this router (see P0-2 remediation):
//  - PUBLIC: GET /public/:providerId — unauthenticated, intentionally public.
//  - AUTHENTICATED IDENTITY-LEVEL (any role): session listing/revocation and
//    password change are generic account-security features that happen to be
//    mounted here; they scope purely by req.user.id and have no equivalent
//    route elsewhere, so they stay open to any authenticated active role.
//  - PROVIDER-ONLY: every route that reads/writes ProviderProfile,
//    ProfileModificationRequest (schema-scoped to `providerId`), or the
//    provider's own public-preview — having a ProviderProfile row must not
//    itself grant PROVIDER authority, so these require the caller to already
//    hold PROVIDER in roles[]/activeRole via the legitimate add-account-type/
//    registration provisioning flow.
//  - ADMIN-ONLY: sensitive-change review — already gated, unchanged.
const requireProvider = authorize(AccountType.PROVIDER_INDIVIDUAL, AccountType.PROVIDER_COMPANY);

// Public read-only profile endpoints must remain outside the authenticated
// middleware. Private preview (/public without an id) is still protected by
// the middleware below because it resolves the current user's profile.
// aiLimiter (security follow-up): this endpoint triggers a real Gemini call
// (generateAiMetrics) on a cache miss and has zero authentication, so it
// must carry the same AI-cost rate limit every other AI-triggering public
// endpoint does (see F6's marketplace/ai-recommendations).
router.get('/public/:providerId', aiLimiter, providerProfileController.getPublicProfile);

// Ensure all routes are authenticated
router.use(authenticate, requireActiveUser);

router.post('/documents/upload', requireProvider, documentUpload.single('file'), async (req, res, next) => {
	try {
	if (!req.file) return res.status(400).json({ success: false, message: 'A PDF, JPG or PNG file is required' });
	const stored = await uploadMulterFile(req.file, `waseetai/providers/${req.user!.id}/documents`);
	res.status(201).json({ success: true, data: { url: stored.url, name: stored.fileName } });
	} catch (error) { next(error); }
});

router.get('/me', requireProvider, providerProfileController.getProfile);
// Identity-level: session management and password change apply to any
// authenticated role, not just PROVIDER — no authorize() gate here.
router.get('/sessions', providerProfileController.getActiveSessions);
router.delete('/sessions/:id', authLimiter, providerProfileController.revokeSession);
router.put('/password', authLimiter, providerProfileController.changePassword);
router.post('/suggest-bio', requireProvider, aiLimiter, providerProfileController.suggestBio);
router.post('/suggest-skills', requireProvider, aiLimiter, providerProfileController.suggestSkills);
router.get('/setup', requireProvider, providerProfileController.getSetupData);
router.post('/setup', requireProvider, providerProfileController.saveSetupData);
// Self-preview variant of the same getPublicProfile handler as the public
// `/public/:providerId` route above — it hits the identical generateAiMetrics
// Gemini call on a cache miss, so it needs the same aiLimiter (Batch 6 gap
// fix; this route was missing it while its sibling already had it).
router.get('/public', requireProvider, aiLimiter, providerProfileController.getPublicProfile);
router.get('/requests', requireProvider, providerProfileController.getModificationRequests);
router.post('/requests', requireProvider, providerProfileController.createModificationRequest);
router.post('/requests/:id/cancel', requireProvider, providerProfileController.cancelModificationRequest);
router.post('/requests/:id/review', authorize(AccountType.ADMIN, AccountType.SUPER_ADMIN), providerProfileController.reviewSensitiveChange);
router.get('/admin/pending-reviews', authorize(AccountType.ADMIN, AccountType.SUPER_ADMIN), providerProfileController.getPendingSensitiveReviews);
router.get('/requests/:tabName', requireProvider, providerProfileController.getChangeRequests);
router.post('/sensitive-change', requireProvider, providerProfileController.initiateSensitiveChange);
router.post('/sensitive-change/verify', requireProvider, providerProfileController.verifySensitiveChange);
router.put('/basic-info', requireProvider, providerProfileController.updateBasicInfo);
router.put('/contact', requireProvider, providerProfileController.updateContactInfo);
router.put('/banking', requireProvider, providerProfileController.updateBankingInfo);
router.put('/docs', requireProvider, providerProfileController.updateDocsInfo);
router.put('/skills', requireProvider, providerProfileController.updateSkills);
router.post('/portfolio', requireProvider, providerProfileController.addPortfolioItem);
router.put('/portfolio/:id', requireProvider, providerProfileController.updatePortfolioItem);
router.delete('/portfolio/:id', requireProvider, providerProfileController.deletePortfolioItem);

export default router;
