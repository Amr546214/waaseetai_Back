import { Router } from 'express';
import { specialtyController } from '../controllers/specialty.controller';
import { memoryUpload } from '../utils/cloudinary-storage';
import { SPECIALTY_UPLOAD_MIME_TYPES } from '../utils/upload-mime-types';
import { AccountType } from '@prisma/client';
import { requireActiveUser, authenticate, authorize } from '../middlewares/auth.middleware';
import { requireOwnedProviderSpecialtyFromBody } from '../utils/provider-specialty-access';

const upload = memoryUpload({ files: 30, allowedMimeTypes: SPECIALTY_UPLOAD_MIME_TYPES });

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

export default router;
