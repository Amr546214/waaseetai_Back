import { z } from 'zod';

export const createWithdrawalSchema = z.object({
  amount: z.number().positive('المبلغ يجب أن يكون أكبر من صفر'),
  method: z.string().trim().min(2, 'طريقة السحب مطلوبة').default('bank_transfer'),
  accountName: z.string().trim().optional(),
  accountNumber: z.string().trim().optional(),
  iban: z.string().trim().optional(),
}).refine(data => data.iban || data.accountNumber, {
  message: 'يجب توفير رقم IBAN أو رقم الحساب',
  path: ['iban'],
});

export const resolveWithdrawalSchema = z.object({
  adminNote: z.string().trim().max(2000).optional()
});

export const rejectWithdrawalSchema = z.object({
  rejectionReason: z.string().trim().min(2).max(2000)
});

export type CreateWithdrawalInput = z.infer<typeof createWithdrawalSchema>;
export type ResolveWithdrawalInput = z.infer<typeof resolveWithdrawalSchema>;
export type RejectWithdrawalInput = z.infer<typeof rejectWithdrawalSchema>;
