import { z } from 'zod';

// Phase 6 — special offers (auto-applied, no customer-entered code). Field
// validation mirrors couponFieldsSchema in cart-checkout.dto.ts. The
// BUNDLE vs DIRECT_DISCOUNT shape rule (see SpecialOffer in schema.prisma)
// is enforced here at the request level AND re-checked against the merged
// row in provider-special-offer.service.ts (update is partial, so the DTO
// alone can't see the stored type/fields).

const specialOfferFieldsSchema = z.object({
  type: z.enum(['BUNDLE', 'DIRECT_DISCOUNT']),
  name: z.string().trim().min(1).max(100),
  // BUNDLE: ordering primaryService (X) unlocks the discount on
  // beneficiaryService (Y) within validityDays of the first X order.
  primaryServiceId: z.string().uuid().optional().nullable(),
  beneficiaryServiceId: z.string().uuid().optional().nullable(),
  validityDays: z.number().int().positive().max(365).optional().nullable(),
  // DIRECT_DISCOUNT: discount badge on a single service.
  targetServiceId: z.string().uuid().optional().nullable(),
  // Always a percentage (special offers have no fixed-amount mode).
  discountValue: z.number().positive().max(100),
  startAt: z.coerce.date().optional(),
  expiresAt: z.coerce.date().optional().nullable(),
  badgeText: z.string().trim().min(1).max(50),
  customerMessage: z.string().trim().max(2000).optional().nullable(),
  // Internal-only note, never meant for the customer-facing side.
  internalNote: z.string().trim().max(2000).optional().nullable(),
  assignedToTeamMemberId: z.string().uuid().optional().nullable()
  // approvalStatus / rejectionReason / createdByTeamMemberId are
  // server-set, exactly as with coupons.
});

type ShapeFields = {
  type?: 'BUNDLE' | 'DIRECT_DISCOUNT';
  primaryServiceId?: string | null;
  beneficiaryServiceId?: string | null;
  targetServiceId?: string | null;
  validityDays?: number | null;
  startAt?: Date;
  expiresAt?: Date | null;
};

// Returns a list of { path, message } violations of the BUNDLE vs
// DIRECT_DISCOUNT shape rule. Shared with the service layer so the exact
// same rule is applied to the merged (stored + patch) row on update.
export function specialOfferShapeIssues(value: ShapeFields): { path: string; message: string }[] {
  const issues: { path: string; message: string }[] = [];
  if (value.type === 'BUNDLE') {
    if (!value.primaryServiceId) issues.push({ path: 'primaryServiceId', message: 'عرض الباقة يتطلب تحديد النموذج الأساسي' });
    if (!value.beneficiaryServiceId) issues.push({ path: 'beneficiaryServiceId', message: 'عرض الباقة يتطلب تحديد النموذج المستفيد' });
    if (!value.validityDays) issues.push({ path: 'validityDays', message: 'عرض الباقة يتطلب تحديد مدة الصلاحية بالأيام' });
    if (value.primaryServiceId && value.beneficiaryServiceId && value.primaryServiceId === value.beneficiaryServiceId) {
      issues.push({ path: 'beneficiaryServiceId', message: 'النموذج المستفيد يجب أن يختلف عن النموذج الأساسي' });
    }
    if (value.targetServiceId) issues.push({ path: 'targetServiceId', message: 'عرض الباقة لا يقبل نموذجًا مستهدفًا' });
  } else if (value.type === 'DIRECT_DISCOUNT') {
    if (!value.targetServiceId) issues.push({ path: 'targetServiceId', message: 'الخصم المباشر يتطلب تحديد النموذج' });
    if (value.primaryServiceId || value.beneficiaryServiceId) issues.push({ path: 'primaryServiceId', message: 'الخصم المباشر لا يقبل نماذج باقة' });
  }
  if (value.expiresAt && value.startAt && value.expiresAt <= value.startAt) {
    issues.push({ path: 'expiresAt', message: 'تاريخ الانتهاء يجب أن يكون بعد تاريخ البداية' });
  }
  return issues;
}

export const createSpecialOfferSchema = specialOfferFieldsSchema.extend({
  // Only meaningful at creation — same as createCouponSchema.
  createdByTeamMemberId: z.string().uuid().optional().nullable()
}).superRefine((value, ctx) => {
  for (const issue of specialOfferShapeIssues(value)) ctx.addIssue({ code: 'custom', path: [issue.path], message: issue.message });
});

// Partial: the full shape rule is re-checked in the service against the
// merged row; here only the date ordering is checkable in isolation.
export const updateSpecialOfferSchema = specialOfferFieldsSchema.partial().extend({ active: z.boolean().optional() }).superRefine((value, ctx) => {
  if (value.expiresAt && value.startAt && value.expiresAt <= value.startAt) {
    ctx.addIssue({ code: 'custom', path: ['expiresAt'], message: 'تاريخ الانتهاء يجب أن يكون بعد تاريخ البداية' });
  }
});

export const specialOfferApprovalDecisionSchema = z.object({
  decision: z.enum(['APPROVED', 'REJECTED']),
  rejectionReason: z.string().trim().max(1000).optional().nullable()
}).superRefine((value, ctx) => {
  if (value.decision === 'REJECTED' && !value.rejectionReason) {
    ctx.addIssue({ code: 'custom', path: ['rejectionReason'], message: 'يجب توضيح سبب الرفض' });
  }
});
