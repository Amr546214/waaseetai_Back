import { Router } from 'express';
import { specialtyController } from '../controllers/specialty.controller';
import { authenticate } from '../middlewares/auth.middleware'; // Assuming an auth middleware exists
import { memoryUpload } from '../utils/cloudinary-storage';

const upload = memoryUpload({ files: 30 });

const router = Router();

router.get('/categories', specialtyController.getCategories);
router.get('/public', specialtyController.getPublicSpecialties);

router.post('/provider/specialties/step1-select', authenticate, specialtyController.selectSpecialty);
router.post('/provider/specialties/step2-upload', authenticate, upload.any(), specialtyController.uploadSamples);
router.post('/provider/specialties/step3-audit', authenticate, specialtyController.audit);
router.get('/provider/specialties/step4-test/:specialtyId', authenticate, specialtyController.getTest);
router.post('/provider/specialties/step4-submit', authenticate, specialtyController.submitTest);

export default router;
