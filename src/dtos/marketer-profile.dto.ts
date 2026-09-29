import { z } from 'zod';
import { isValidIban } from '../utils/iban.util';

export const updateBankInfoSchema = z.object({
  bankName: z.string().trim().max(120).optional(),
  accountHolderName: z.string().trim().max(120).optional(),
  iban: z.string().trim().max(34).optional().refine(
    (value) => !value || isValidIban(value),
    { message: 'رقم IBAN غير صحيح' }
  ),
  swiftCode: z.string().trim().max(11).optional(),
});

export type UpdateBankInfoInput = z.infer<typeof updateBankInfoSchema>;
