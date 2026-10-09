import { z } from 'zod';
import { authPasswordSchema, AUTH_PASSWORD_MAX_LENGTH } from '../utils/auth-password-policy';

// POST /api/profiles/password-change-request — a client asks to change the password. Same policy as registration / reset.
export const clientPasswordChangeSchema = z.object({
  currentPassword: z.string({ message: 'كلمة المرور الحالية مطلوبة' }).min(1, 'كلمة المرور الحالية مطلوبة'),
  newPassword: authPasswordSchema.max(AUTH_PASSWORD_MAX_LENGTH, 'كلمة المرور يجب أن لا تزيد على 72 حرفًا'),
  confirmPassword: z.string({ message: 'تأكيد كلمة المرور مطلوب' }).min(1, 'تأكيد كلمة المرور مطلوب'),
}).superRefine((data, ctx) => {
  if (data.confirmPassword !== data.newPassword) ctx.addIssue({ code: 'custom', path: ['confirmPassword'], message: 'تأكيد كلمة المرور غير مطابق' });
  if (data.currentPassword === data.newPassword) ctx.addIssue({ code: 'custom', path: ['newPassword'], message: 'كلمة المرور الجديدة يجب أن تختلف عن الحالية' });
});

export type ClientPasswordChangeInput = z.infer<typeof clientPasswordChangeSchema>;
