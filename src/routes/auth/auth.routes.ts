import { Router } from 'express';
import { authController } from '../../controllers/auth.controller';
import { validateRequest } from '../../middlewares/validation.middleware';
import { registerSchema, verifyOtpSchema, loginSchema, resendOtpSchema, googleAuthSchema } from './auth.schema';
import { authLimiter } from '../../middlewares/rate-limit.middleware';
import { authenticate, authorize, requireActiveUser } from '../../middlewares/auth.middleware';
import { AccountType } from '@prisma/client';
import { memoryUpload } from '../../utils/cloudinary-storage';
import { getOnboardingStatus, uploadOnboardingDocument } from '../../controllers/onboarding.controller';

const onboardingUpload = memoryUpload({
  fileSize: 10 * 1024 * 1024,
  files: 1,
  allowedMimeTypes: new Set(['application/pdf', 'image/jpeg', 'image/png'])
});

const router = Router();

// ==========================================
// AUTHENTICATION ROUTES (/api/auth)
// ==========================================

router.post(
  '/register',
  authLimiter,
  validateRequest(registerSchema),
  authController.register
);

router.post(
  '/verify-otp',
  authLimiter,
  validateRequest(verifyOtpSchema),
  authController.verifyOtp
);

router.post(
  '/resend-otp',
  authLimiter,
  validateRequest(resendOtpSchema),
  authController.resendOtp
);

router.post(
  '/login',
  authLimiter,
  validateRequest(loginSchema),
  authController.login
);

router.post(
  '/google',
  authLimiter,
  validateRequest(googleAuthSchema),
  authController.googleAuth
);

router.post(
  '/logout',
  authenticate,
  authController.logout
);

router.post('/onboarding/upload', authenticate, requireActiveUser, authorize(AccountType.CLIENT_COMPANY, AccountType.CLIENT_INDIVIDUAL), onboardingUpload.single('file'), uploadOnboardingDocument);
router.get('/onboarding/status', authenticate, requireActiveUser, authorize(AccountType.CLIENT_COMPANY, AccountType.CLIENT_INDIVIDUAL), getOnboardingStatus);

export default router;
