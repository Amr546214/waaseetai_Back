import { Router } from 'express';
import * as providerProfileController from '../controllers/provider-profile.controller';
import { authenticate, requireActiveUser } from '../middlewares/auth.middleware';
import { authorize } from '../middlewares/auth.middleware';
import { AccountType } from '@prisma/client';
import { memoryUpload, uploadMulterFile } from '../utils/cloudinary-storage';
import { authLimiter } from '../middlewares/rate-limit.middleware';

const router = Router();
const documentUpload = memoryUpload({
	fileSize: 10 * 1024 * 1024,
	files: 1,
	allowedMimeTypes: new Set(['application/pdf', 'image/jpeg', 'image/png'])
});

// Public read-only profile endpoints must remain outside the authenticated
// middleware. Private preview (/public without an id) is still protected by
// the middleware below because it resolves the current user's profile.
router.get('/public/:providerId', providerProfileController.getPublicProfile);

// Ensure all routes are authenticated
router.use(authenticate, requireActiveUser);

router.post('/documents/upload', documentUpload.single('file'), async (req, res, next) => {
	try {
	if (!req.file) return res.status(400).json({ success: false, message: 'A PDF, JPG or PNG file is required' });
	const stored = await uploadMulterFile(req.file, `waseetai/providers/${req.user!.id}/documents`);
	res.status(201).json({ success: true, data: { url: stored.url, name: stored.fileName } });
	} catch (error) { next(error); }
});

router.get('/me', providerProfileController.getProfile);
router.get('/sessions', providerProfileController.getActiveSessions);
router.delete('/sessions/:id', authLimiter, providerProfileController.revokeSession);
router.put('/password', authLimiter, providerProfileController.changePassword);
router.get('/setup', providerProfileController.getSetupData);
router.post('/setup', providerProfileController.saveSetupData);
router.get('/public', providerProfileController.getPublicProfile);
router.get('/requests', providerProfileController.getModificationRequests);
router.post('/requests', providerProfileController.createModificationRequest);
router.post('/requests/:id/cancel', providerProfileController.cancelModificationRequest);
router.post('/requests/:id/review', authorize(AccountType.ADMIN, AccountType.SUPER_ADMIN), providerProfileController.reviewSensitiveChange);
router.get('/admin/pending-reviews', authorize(AccountType.ADMIN, AccountType.SUPER_ADMIN), providerProfileController.getPendingSensitiveReviews);
router.get('/requests/:tabName', providerProfileController.getChangeRequests);
router.post('/sensitive-change', providerProfileController.initiateSensitiveChange);
router.post('/sensitive-change/verify', providerProfileController.verifySensitiveChange);
router.put('/basic-info', providerProfileController.updateBasicInfo);
router.put('/contact', providerProfileController.updateContactInfo);
router.put('/banking', providerProfileController.updateBankingInfo);
router.put('/docs', providerProfileController.updateDocsInfo);
router.put('/skills', providerProfileController.updateSkills);
router.post('/portfolio', providerProfileController.addPortfolioItem);
router.put('/portfolio/:id', providerProfileController.updatePortfolioItem);
router.delete('/portfolio/:id', providerProfileController.deletePortfolioItem);

export default router;
