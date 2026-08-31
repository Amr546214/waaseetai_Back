import { Router } from 'express';
import { authController } from '../../controllers/auth.controller';
import { validateRequest } from '../../middlewares/validation.middleware';
import { registerSchema, verifyOtpSchema, loginSchema, resendOtpSchema, googleAuthSchema } from './auth.schema';
import { authLimiter } from '../../middlewares/rate-limit.middleware';
import { authenticate, authorize } from '../../middlewares/auth.middleware';
import { AccountType } from '@prisma/client';

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

// ==========================================
// TESTING PROTECTED ROUTE
// ==========================================
router.get(
  '/protected-test',
  authenticate,
  (req, res) => {
    res.status(200).json({
      success: true,
      message: 'تم التحقق من الحماية بنجاح',
      user: req.user
    });
  }
);

export default router;
