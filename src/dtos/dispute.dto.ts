import { z } from 'zod';
import { isFinancialCode } from '../utils/dispute-resolution';

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
    .max(120, 'قرار النزاع طويل: الحد الأقصى 120 حرفًا، ضع التفاصيل في خانة الملاحظات')
    // A closure is a statement with NO financial effect. A bare financial code here would read as if money moved, so it is refused;
    // the same words inside a longer sentence are plain text and stay inert.
    .refine((v) => !isFinancialCode(v), 'هذا قرار مالي: استخدم مسار «قرار مالي» وحدد المبالغ والتأكيد، فالقرار النصي لا ينقل أي مبلغ'),
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

// Financial decision: the ONLY way a dispute moves money. Every amount is explicit (USD, at most 2 decimals) and must settle the whole HELD balance
// of the escrow (refundToClient + releaseToProvider = held), which the server re-reads inside the transaction. `confirm: true` is a deliberate second step.
const money = (label: string) => z.number({ error: `${label}: أدخل مبلغًا صحيحًا` })
  .finite(`${label}: أدخل مبلغًا صحيحًا`)
  .min(0, `${label}: لا يمكن أن يكون سالبًا`)
  .max(100000000, `${label}: المبلغ كبير جدًا`)
  .refine((n) => Math.abs(Math.round(n * 100) - n * 100) < 1e-6, `${label}: بحد أقصى خانتان عشريتان`);

export const resolveDisputeFinancialSchema = z.object({
  outcome: z.enum(['REFUND_CLIENT', 'RELEASE_PROVIDER', 'SPLIT'], { error: 'نوع القرار المالي غير صالح' }),
  refundToClient: money('مبلغ الاسترداد للعميل'),
  releaseToProvider: money('المبلغ المصروف لمقدم الخدمة (قبل العمولة)'),
  expectedHeldAmount: money('المبلغ المحتجز المعروض').refine((n) => n > 0, 'لا يوجد مبلغ محتجز للتسوية'),
  confirm: z.literal(true, { error: 'يجب تأكيد تنفيذ القرار المالي صراحةً' }),
  resolutionNote: z.preprocess(
    (v) => (typeof v === 'string' && v.trim() === '' ? undefined : v),
    z.string().trim().min(2, 'الملاحظة قصيرة جدًا').max(10000, 'الملاحظة طويلة جدًا (الحد الأقصى 10000 حرف)').optional()
  )
}).superRefine((v, ctx) => {
  // `path` names the amount box the message belongs under (the FE puts it right there).
  const bad = (message: string, field: 'refundToClient' | 'releaseToProvider') => ctx.addIssue({ code: 'custom', message, path: [field] });
  if (v.outcome === 'REFUND_CLIENT' && !(v.refundToClient > 0 && v.releaseToProvider === 0)) bad('الاسترداد الكامل: مبلغ الاسترداد أكبر من صفر ومبلغ مقدم الخدمة صفر', v.refundToClient > 0 ? 'releaseToProvider' : 'refundToClient');
  if (v.outcome === 'RELEASE_PROVIDER' && !(v.releaseToProvider > 0 && v.refundToClient === 0)) bad('الصرف الكامل: مبلغ مقدم الخدمة أكبر من صفر ومبلغ الاسترداد صفر', v.releaseToProvider > 0 ? 'refundToClient' : 'releaseToProvider');
  if (v.outcome === 'SPLIT' && !(v.releaseToProvider > 0 && v.refundToClient > 0)) bad('التقسيم: يجب أن يكون المبلغان أكبر من صفر', v.releaseToProvider > 0 ? 'refundToClient' : 'releaseToProvider');
});
export type ResolveDisputeFinancialInput = z.infer<typeof resolveDisputeFinancialSchema>;
