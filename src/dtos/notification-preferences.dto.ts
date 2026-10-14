import { z } from 'zod';

// Values are switches (boolean) plus a few short text choices the marketer page stores (communication language / timezone), so a page that sends back what it loaded never gets a 400.
// Bounded so a client can't grow this JSON blob unboundedly — every real
// role's toggle set today (client + provider + marketer combined) is well
// under 30 keys; this leaves generous room for new toggles.
export const updateNotificationPreferencesSchema = z.object({
  settings: z.record(z.string().min(1).max(64), z.union([z.boolean(), z.string().max(64)])).refine(
    (obj) => Object.keys(obj).length > 0 && Object.keys(obj).length <= 100,
    { message: 'settings يجب أن يحتوي على مفتاح واحد على الأقل وبحد أقصى 100 مفتاح' }
  ),
});

export type UpdateNotificationPreferencesInput = z.infer<typeof updateNotificationPreferencesSchema>;
