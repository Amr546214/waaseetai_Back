import { z } from 'zod';

export const createProjectSchema = z.object({
  title: z.string().min(5, 'عنوان الطلب يجب أن يكون 5 أحرف على الأقل').max(200),
  description: z.string().min(20, 'وصف المشروع يجب أن يكون 20 حرف على الأقل'),
  
  specialty: z.string().min(1, 'يجب تحديد التخصص'),
  subSpecialties: z.array(z.string()).max(5, 'الحد الأقصى 5 تخصصات فرعية').optional().default([]),
  
  ndaType: z.enum(['none', 'standard', 'custom']).optional().default('standard'),
  ipRights: z.enum(['client', 'shared', 'provider']).optional().default('client'),
  
  provLevel: z.string().optional(),
  provRating: z.number().min(1).max(5).optional(),
  provLang: z.string().optional(),
  provLocation: z.string().optional(),
  customConditions: z.string().optional(),
  
  requirements: z.array(z.string()).optional().default([]),
  outputs: z.string().optional(),
  deliveryDays: z.number().int().min(1, 'يجب تحديد مدة التنفيذ بالأيام'),
  
  budgetType: z.enum(['range', 'fixed', 'hourly']).optional().default('range'),
  budgetMin: z.number().positive().optional(),
  budgetMax: z.number().positive().optional(),
  budgetFixed: z.number().positive().optional(),
  budgetHourly: z.number().positive().optional(),
  allowNegotiation: z.boolean().optional().default(true),
  
  splitMilestones: z.boolean().optional().default(false),
  milestones: z.array(z.object({
    name: z.string().min(1),
    pct: z.number().min(1).max(100)
  })).optional(),
  
  attachments: z.array(z.string()).optional().default([])
}).superRefine((data, ctx) => {
  if (data.budgetType === 'range') {
    if (!data.budgetMin || !data.budgetMax) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'يجب تحديد الحد الأدنى والأعلى للميزانية'
      });
    } else if (data.budgetMin > data.budgetMax) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'الحد الأدنى يجب أن يكون أقل من الحد الأعلى'
      });
    }
  } else if (data.budgetType === 'fixed' && !data.budgetFixed) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'يجب تحديد الميزانية الثابتة'
    });
  } else if (data.budgetType === 'hourly' && !data.budgetHourly) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'يجب تحديد ميزانية الساعة'
    });
  }
  
  if (data.splitMilestones && data.milestones) {
    const totalPct = data.milestones.reduce((acc, m) => acc + m.pct, 0);
    if (totalPct !== 100) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'إجمالي الدفعات يجب أن يكون 100%'
      });
    }
  }
});

export type CreateProjectDto = z.infer<typeof createProjectSchema>;
