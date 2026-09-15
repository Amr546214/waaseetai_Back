import { z } from 'zod';

const meaningfulText = (value: string | undefined): boolean => {
  return typeof value === 'string' && value.trim().length > 0;
};

const meaningfulNumber = (value: number | undefined): boolean => {
  return typeof value === 'number' && Number.isFinite(value) && value !== 0;
};

export const amendmentAnalysisSchema = z.object({
  scopeChange: z.string().trim().max(1200).optional(),
  requestedBudgetDelta: z.number().finite().optional(),
  requestedDurationDeltaDays: z.number().int().refine(
    value => Number.isSafeInteger(value),
    { message: 'requestedDurationDeltaDays must be a safe integer.' }
  ).optional(),
}).strict().superRefine((data, ctx) => {
  if (
    meaningfulText(data.scopeChange) ||
    meaningfulNumber(data.requestedBudgetDelta) ||
    meaningfulNumber(data.requestedDurationDeltaDays)
  ) {
    return;
  }

  ctx.addIssue({
    code: z.ZodIssueCode.custom,
    message:
      'At least one meaningful scope, budget, or duration change is required.',
    path: [],
  });
});

export type AmendmentAnalysisDto = z.infer<typeof amendmentAnalysisSchema>;
