import { z } from 'zod';
import { nonPaypalPayoutKeys, PAYPAL_ONLY_MESSAGE } from '../utils/client-payout-fields';

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
// PayPal is the only withdrawal method: a bank_transfer / other method, or any bank / IBAN / wallet field, is a 400. The destination is the
// provider's saved PayPal email (never part of the body).
export const createWithdrawalSchema = z.object({
  amount: z.number().positive('المبلغ يجب أن يكون أكبر من صفر'),
  method: z.string().trim().min(2, 'طريقة السحب مطلوبة').default('paypal'),
}).catchall(z.unknown()).superRefine((data, ctx) => {
  for (const key of nonPaypalPayoutKeys(data)) ctx.addIssue({ code: 'custom', path: [key], message: PAYPAL_ONLY_MESSAGE });
  if (data.method !== 'paypal') ctx.addIssue({ code: 'custom', path: ['method'], message: PAYPAL_ONLY_MESSAGE });
  if (data.paypalEmail !== undefined) ctx.addIssue({ code: 'custom', path: ['paypalEmail'], message: PAYPAL_ONLY_MESSAGE });
});

// Marketer/affiliate withdrawal — destination is NEVER taken from the
// request body. It is resolved server-side, at creation time, from the
// authenticated affiliate's own saved PayPal email, the same "immutable snapshot from a trusted profile" pattern
// createForProvider() already uses for a PayPal destination. The only real
// input here is the amount.
export const createMarketerWithdrawalSchema = z.object({
  amount: z.number().positive('المبلغ يجب أن يكون أكبر من صفر'),
}).catchall(z.unknown()).superRefine((data, ctx) => {
  // PayPal only (resolved server-side from the marketer's saved PayPal email): a bank / IBAN / wallet / paypal destination in the body is a 400.
  for (const key of [...nonPaypalPayoutKeys(data), ...(data.method !== undefined ? ['method'] : []), ...(data.paypalEmail !== undefined ? ['paypalEmail'] : [])]) {
    ctx.addIssue({ code: 'custom', path: [key], message: PAYPAL_ONLY_MESSAGE });
  }
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
