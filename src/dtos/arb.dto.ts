import { z } from 'zod';

// The browser sends ONLY the net USD amount it wants added to the wallet. The charged amount, currency, fee and rate are derived on the server.
export const initiateArbPaymentSchema = z.object({
  netUsd: z.number().finite().min(50, 'الحد الأدنى للإيداع هو 50 دولارًا').max(100000, 'الحد الأقصى للإيداع هو 100,000 دولار'),
  // only after the user was shown that an earlier attempt may still be collected by the bank and accepted that risk
  acknowledgePreviousRisk: z.boolean().optional(),
}).strict();

export type InitiateArbPaymentDto = z.infer<typeof initiateArbPaymentSchema>;
