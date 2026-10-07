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
// Finance #32: the bank destination is NEVER taken from the request body, exactly like the PayPal one. Deliberately no iban /
// accountName / accountNumber field exists on this schema: zod drops any such key a caller sends, so it cannot reach the service
// (by construction). A bank withdrawal uses the bank data stored on the provider's own profile (see createForProvider).
export const createWithdrawalSchema = z.object({
  amount: z.number().positive('المبلغ يجب أن يكون أكبر من صفر'),
  method: z.string().trim().min(2, 'طريقة السحب مطلوبة').default('bank_transfer'),
});

// Marketer/affiliate withdrawal — destination is NEVER taken from the
// request body. It is resolved server-side, at creation time, from the
// authenticated affiliate's own AffiliateProfile (bankName/accountHolderName/
// iban), the same "immutable snapshot from a trusted profile" pattern
// createForProvider() already uses for a PayPal destination. The only real
// input here is the amount.
export const createMarketerWithdrawalSchema = z.object({
  amount: z.number().positive('المبلغ يجب أن يكون أكبر من صفر'),
});

export const resolveWithdrawalSchema = z.object({
  adminNote: z.string().trim().max(2000).optional()
});

export const rejectWithdrawalSchema = z.object({
  rejectionReason: z.string().trim().min(2).max(2000)
});

export type CreateWithdrawalInput = z.infer<typeof createWithdrawalSchema>;
export type CreateMarketerWithdrawalInput = z.infer<typeof createMarketerWithdrawalSchema>;
export type ResolveWithdrawalInput = z.infer<typeof resolveWithdrawalSchema>;
export type RejectWithdrawalInput = z.infer<typeof rejectWithdrawalSchema>;
