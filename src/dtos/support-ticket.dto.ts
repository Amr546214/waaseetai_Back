import { z } from 'zod';

export const createSupportTicketSchema = z.object({
  subject: z.string().trim().min(5, 'عنوان التذكرة قصير جدًا').max(200),
  category: z.string().trim().min(1, 'اختر التصنيف'),
  priority: z.string().trim().max(30).optional(),
  description: z.string().trim().min(20, 'الوصف قصير جدًا، أضف تفاصيل أكثر').max(5000),
  relatedOrder: z.string().trim().max(100).optional(),
  relatedProject: z.string().trim().max(200).optional(),
  relatedMember: z.string().trim().max(200).optional(),
  ccEmail: z.string().trim().email('بريد إلكتروني غير صحيح').optional().or(z.literal('')),
});

export const replyToTicketSchema = z.object({
  body: z.string().trim().min(1, 'أدخل نص الرد').max(5000),
});

export const SUPPORT_TICKET_STATUSES = ['OPEN', 'IN_PROGRESS', 'AWAITING_CUSTOMER', 'RESOLVED', 'CLOSED'] as const;

export const staffReplySchema = z.object({
  body: z.string().trim().min(1, 'أدخل نص الرد').max(5000),
  status: z.enum(SUPPORT_TICKET_STATUSES, { message: 'حالة التذكرة غير صحيحة' }).optional(),
});

export const setTicketStatusSchema = z.object({
  status: z.enum(SUPPORT_TICKET_STATUSES, { message: 'حالة التذكرة غير صحيحة' }),
});

export type CreateSupportTicketInput = z.infer<typeof createSupportTicketSchema>;
export type ReplyToTicketInput = z.infer<typeof replyToTicketSchema>;
