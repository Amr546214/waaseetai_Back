import { z } from 'zod';

// The ONE password policy of the platform (registration, password reset, and a client's password-change request).
export const AUTH_PASSWORD_MIN_LENGTH = 8;
export const AUTH_PASSWORD_MAX_LENGTH = 72; // bcrypt only reads the first 72 bytes

export const authPasswordSchema = z
  .string()
  .min(AUTH_PASSWORD_MIN_LENGTH, 'كلمة المرور يجب أن لا تقل عن 8 أحرف')
  .regex(/[A-Z]/, 'كلمة المرور يجب أن تحتوي على حرف كبير واحد على الأقل')
  .regex(/[0-9]/, 'كلمة المرور يجب أن تحتوي على رقم واحد على الأقل');
