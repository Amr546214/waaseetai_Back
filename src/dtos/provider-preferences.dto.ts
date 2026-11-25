import { z } from 'zod';

// Provider display preferences, stored inside provider_profiles.preferences (existing Json column — no migration). Merged into the JSON so other keys survive.
// one zone per country the registration forms offer (the zone follows the chosen country), plus GMT
export const TIMEZONES = [
  'Asia/Riyadh', 'Asia/Dubai', 'Asia/Kuwait', 'Africa/Cairo', 'Asia/Amman', 'GMT',
  'Asia/Qatar', 'Asia/Bahrain', 'Asia/Muscat', 'Asia/Baghdad', 'Asia/Damascus', 'Asia/Beirut', 'Asia/Hebron', 'Asia/Aden',
  'Africa/Tripoli', 'Africa/Tunis', 'Africa/Algiers', 'Africa/Casablanca', 'Africa/Khartoum', 'Africa/Nouakchott',
  'Europe/Istanbul', 'Europe/London', 'Europe/Berlin', 'Europe/Paris', 'America/New_York', 'America/Toronto'
] as const;
export const NOTIFICATION_CHANNELS = ['push', 'email'] as const;

export const updateProviderPreferencesSchema = z.object({
  preferredCommunicationLanguage: z.enum(['ar', 'en'], { message: 'لغة الواجهة غير مدعومة' }).optional(),
  timezone: z.enum(TIMEZONES, { message: 'المنطقة الزمنية غير مدعومة' }).optional(),
  notifChannels: z.array(z.enum(NOTIFICATION_CHANNELS)).max(NOTIFICATION_CHANNELS.length).optional(),
}).refine(v => Object.keys(v).length > 0, { message: 'لا توجد تفضيلات للحفظ' });

export type UpdateProviderPreferencesInput = z.infer<typeof updateProviderPreferencesSchema>;
