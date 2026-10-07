import { Router } from 'express';
import { authController } from '../../controllers/auth.controller';
import { validateRequest } from '../../middlewares/validation.middleware';
import { registerSchema, verifyOtpSchema, loginSchema, resendOtpSchema, googleAuthSchema, forgotPasswordSchema, verifyResetCodeSchema, resetPasswordSchema, verifyLoginOtpSchema, resendLoginOtpSchema } from './auth.schema';
import { authLimiter, otpSendLimiter, otpVerifyLimiters, normalizeOtpIdentifier } from '../../middlewares/rate-limit.middleware';

// Who is receiving the code, for the send limiter (sending is limited per recipient and per IP, apart from authLimiter).
// The key is normalised (trim + lower-case) so different spellings of one account share one bucket, and the limiters are mounted AFTER the
// schema validation so malformed requests never consume (or fill) a bucket.
const byEmail = (req: { body?: { email?: unknown } }) => normalizeOtpIdentifier(req.body?.email);
const byUserId = (req: { body?: { userId?: unknown } }) => { const id = normalizeOtpIdentifier(req.body?.userId); return id ? `user:${id}` : undefined; };
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
  validateRequest(registerSchema),
  otpSendLimiter(byEmail),
  authController.register
);

router.post(
  '/verify-otp',
  validateRequest(verifyOtpSchema),
  ...otpVerifyLimiters((req) => req.body?.userId),
  authController.verifyOtp
);

router.post(
  '/resend-otp',
  validateRequest(resendOtpSchema),
  otpSendLimiter(byUserId),
  authController.resendOtp
);

router.post(
  '/forgot-password',
  validateRequest(forgotPasswordSchema),
  otpSendLimiter(byEmail),
  authController.forgotPassword
);

router.post(
  '/verify-reset-code',
  validateRequest(verifyResetCodeSchema),
  ...otpVerifyLimiters((req) => req.body?.email),
  authController.verifyResetCode
);

router.post(
  '/reset-password',
  validateRequest(resetPasswordSchema),
  ...otpVerifyLimiters((req) => req.body?.email),
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

// Own status, readable in every account state (authenticate only, by design: a blocked account must be able to see why).
router.get('/account-status', authenticate, authController.accountStatus.bind(authController));

router.post(
  '/logout',
  authenticate,
  authController.logout
);

router.post('/onboarding/upload', authenticate, requireActiveUser, authorize(AccountType.CLIENT_COMPANY, AccountType.CLIENT_INDIVIDUAL), onboardingUpload.single('file'), uploadOnboardingDocument);
router.get('/onboarding/status', authenticate, requireActiveUser, authorize(AccountType.CLIENT_COMPANY, AccountType.CLIENT_INDIVIDUAL), getOnboardingStatus);

export default router;
