import { z } from 'zod';

export const resolveWithdrawalSchema = z.object({
  adminNote: z.string().trim().max(2000).optional()
});

export const rejectWithdrawalSchema = z.object({
  rejectionReason: z.string().trim().min(2).max(2000)
});

export type ResolveWithdrawalInput = z.infer<typeof resolveWithdrawalSchema>;
export type RejectWithdrawalInput = z.infer<typeof rejectWithdrawalSchema>;
