import { z } from 'zod';

export const createDisputeSchema = z.object({
  reason: z.string().trim().min(2).max(120),
  description: z.string().trim().min(10).max(10000),
  evidence: z.array(z.string().url()).max(10).optional().default([])
});

// The decision text is the short, public headline (<=120); the details go in the optional note. An EMPTY note is "no note", never a validation failure, and every
// failing field answers with its own Arabic message instead of one generic sentence.
export const resolveDisputeSchema = z.object({
  action: z.enum(['resolve', 'reject'], { error: 'نوع القرار غير صالح' }),
  resolution: z.string({ error: 'اكتب قرار النزاع' }).trim()
    .min(2, 'اكتب قرار النزاع (حرفان على الأقل)')
    .max(120, 'قرار النزاع طويل: الحد الأقصى 120 حرفًا، ضع التفاصيل في خانة الملاحظات'),
  resolutionNote: z.preprocess(
    (v) => (typeof v === 'string' && v.trim() === '' ? undefined : v),
    z.string().trim().min(2, 'الملاحظة قصيرة جدًا: اكتب حرفين على الأقل أو اتركها فارغة').max(10000, 'الملاحظة طويلة جدًا (الحد الأقصى 10000 حرف)').optional()
  )
});

export const assignDisputeSchema = z.object({ assigneeId: z.string().trim().min(1).max(64) });
export const disputeNoteSchema = z.object({ body: z.string().trim().min(1).max(5000) });
export const disputeStatusSchema = z.object({ status: z.enum(['OPEN', 'UNDER_REVIEW']) });

export type CreateDisputeInput = z.infer<typeof createDisputeSchema>;
export type ResolveDisputeInput = z.infer<typeof resolveDisputeSchema>;
