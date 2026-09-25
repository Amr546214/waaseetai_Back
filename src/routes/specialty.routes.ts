import { Router } from 'express';
import { specialtyController } from '../controllers/specialty.controller';
import { memoryUpload } from '../utils/cloudinary-storage';
import { AccountType } from '@prisma/client';
import { requireActiveUser, authenticate, authorize } from '../middlewares/auth.middleware';
import { requireOwnedProviderSpecialtyFromBody } from '../utils/provider-specialty-access';

const upload = memoryUpload({ files: 30 });

const router = Router();
const providerAuth = [
  authenticate,
  requireActiveUser,
  authorize(AccountType.PROVIDER_INDIVIDUAL, AccountType.PROVIDER_COMPANY)
] as const;

router.get('/categories', specialtyController.getCategories);
router.get('/public', specialtyController.getPublicSpecialties);

router.post('/provider/specialties/step1-select', ...providerAuth, specialtyController.selectSpecialty);
router.post('/provider/specialties/step2-upload', ...providerAuth, upload.any(), requireOwnedProviderSpecialtyFromBody, specialtyController.uploadSamples);
router.get('/provider/specialties/step4-test/:specialtyId', ...providerAuth, specialtyController.getTest);
router.post('/provider/specialties/step4-submit', ...providerAuth, requireOwnedProviderSpecialtyFromBody, specialtyController.submitTest);

export default router;
