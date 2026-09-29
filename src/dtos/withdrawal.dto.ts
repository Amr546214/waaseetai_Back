import { z } from 'zod';

// Payout P2-A: 'paypal' is the one method that does NOT require a bank
// destination on this DTO at all — its destination is resolved entirely
// server-side in WithdrawalService.createForProvider() from the
// authenticated provider's own ProviderProfile.paypalPayoutEmail, never from
// anything in this request body. Deliberately no `paypalEmail` field exists
// anywhere on this schema: even if a caller sends one, Zod's default
// non-strict object parsing silently drops any key this schema doesn't
// declare, so an attacker-supplied destination can never reach the service
// layer, by construction — not by a runtime check that could be bypassed.
export const createWithdrawalSchema = z.object({
  amount: z.number().positive('المبلغ يجب أن يكون أكبر من صفر'),
  method: z.string().trim().min(2, 'طريقة السحب مطلوبة').default('bank_transfer'),
  accountName: z.string().trim().optional(),
  accountNumber: z.string().trim().optional(),
  iban: z.string().trim().optional(),
}).superRefine((data, ctx) => {
  // A PayPal withdrawal has no bank destination to validate here at all —
  // requiring IBAN/accountNumber "merely because" the method is PayPal would
  // be exactly the mistake this task's owner decisions explicitly forbid.
  // Every other (i.e. bank) method preserves the EXACT original requirement.
  if (data.method === 'paypal') return;
  if (!data.iban && !data.accountNumber) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'يجب توفير رقم IBAN أو رقم الحساب', path: ['iban'] });
  }
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
