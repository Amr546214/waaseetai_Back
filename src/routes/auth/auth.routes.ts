import { Router } from 'express';
import { authController } from '../../controllers/auth.controller';
import { validateRequest } from '../../middlewares/validation.middleware';
import { registerSchema, verifyOtpSchema, loginSchema, resendOtpSchema, googleAuthSchema, forgotPasswordSchema, verifyResetCodeSchema, resetPasswordSchema, verifyLoginOtpSchema, resendLoginOtpSchema } from './auth.schema';
import { authLimiter, otpSendLimiter } from '../../middlewares/rate-limit.middleware';

// Who is receiving the code, for the send limiter (sending is limited per recipient and per IP, apart from authLimiter).
const byEmail = (req: { body?: { email?: unknown } }) => (typeof req.body?.email === 'string' ? req.body.email : undefined);
const byUserId = (req: { body?: { userId?: unknown } }) => (typeof req.body?.userId === 'string' ? `user:${req.body.userId}` : undefined);
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
  otpSendLimiter(byEmail),
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
  otpSendLimiter(byUserId),
  validateRequest(resendOtpSchema),
  authController.resendOtp
);

router.post(
  '/forgot-password',
  otpSendLimiter(byEmail),
  validateRequest(forgotPasswordSchema),
  authController.forgotPassword
);

router.post(
  '/verify-reset-code',
  authLimiter,
  validateRequest(verifyResetCodeSchema),
  authController.verifyResetCode
);

router.post(
  '/reset-password',
  authLimiter,
  validateRequest(resetPasswordSchema),
  authController.resetPassword
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
  '/login/verify-otp',
  authLimiter,
  validateRequest(verifyLoginOtpSchema),
  authController.verifyLoginOtp
);

router.post(
  '/login/resend-otp',
  authLimiter,
  validateRequest(resendLoginOtpSchema),
  authController.resendLoginOtp
);

router.post(
  '/logout',
  authenticate,
  authController.logout
);

router.post('/onboarding/upload', authenticate, requireActiveUser, authorize(AccountType.CLIENT_COMPANY, AccountType.CLIENT_INDIVIDUAL), onboardingUpload.single('file'), uploadOnboardingDocument);
router.get('/onboarding/status', authenticate, requireActiveUser, authorize(AccountType.CLIENT_COMPANY, AccountType.CLIENT_INDIVIDUAL), getOnboardingStatus);

export default router;
