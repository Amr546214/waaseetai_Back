import { Router } from 'express';
import { MarketplaceServiceController } from '../controllers/marketplace-service.controller';
import { AccountType } from '@prisma/client';
import { authenticate, authorize, requireActiveUser } from '../middlewares/auth.middleware';
import { memoryUpload, uploadMulterFile } from '../utils/cloudinary-storage';

const router = Router();
const controller = new MarketplaceServiceController();
const galleryUpload = memoryUpload({
	fileSize: 10 * 1024 * 1024,
	files: 5,
	allowedMimeTypes: new Set(['image/png', 'image/jpeg', 'image/webp'])
});

router.use(
	authenticate,
	requireActiveUser,
	authorize(AccountType.PROVIDER_INDIVIDUAL, AccountType.PROVIDER_COMPANY)
);

// All routes here should be mounted under /api/provider/services
router.get('/my-market-models', controller.getMyMarketModels.bind(controller));
router.get('/pre-data', controller.getPreData.bind(controller));
router.post('/upload-gallery', galleryUpload.array('attachments', 5), async (req, res, next) => {
	try {
		const files = (req.files as Express.Multer.File[]) || [];
		if (files.length === 0) return res.status(400).json({ success: false, error: 'لم يتم رفع أي صورة' });
		const uploaded = await Promise.all(files.map(file => uploadMulterFile(file, `waseetai/providers/${req.user!.id}/services/gallery`)));
		return res.status(200).json({ success: true, urls: uploaded.map(file => file.url) });
	} catch (error) {
		next(error);
	}
});
router.patch('/:id/visibility', controller.toggleVisibility.bind(controller));
router.get('/:id', controller.getServiceById.bind(controller));
router.put('/:id', controller.updateService.bind(controller));
router.post('/', controller.createService.bind(controller));

export default router;
