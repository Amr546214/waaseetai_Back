import { z } from 'zod';
import { TIMEZONES } from './provider-preferences.dto';

/** PATCH /marketer-overview/settings: only what the marketer settings page really saves. A field left out is not touched. */
export const updateMarketerSettingsSchema = z.object({
  inApp: z.boolean({ message: 'قيمة إشعارات التطبيق غير صحيحة' }).optional(),
  email: z.boolean({ message: 'قيمة إشعارات البريد غير صحيحة' }).optional(),
  newReferral: z.boolean({ message: 'قيمة تنبيه الإحالة غير صحيحة' }).optional(),
  newCommission: z.boolean({ message: 'قيمة تنبيه العمولة غير صحيحة' }).optional(),
  communicationLanguage: z.enum(['ar', 'en'], { message: 'لغة التواصل غير مدعومة' }).optional(),
  /** null = back to the browser's own zone (the saved value is removed). */
  timezone: z.enum(TIMEZONES, { message: 'المنطقة الزمنية غير مدعومة' }).nullable().optional(),
}).strict().refine(v => Object.keys(v).length > 0, { message: 'لا توجد إعدادات للحفظ' });

export type UpdateMarketerSettingsInput = z.infer<typeof updateMarketerSettingsSchema>;
