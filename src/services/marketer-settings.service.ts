import { prisma } from '../config/db';
import { TIMEZONES } from '../dtos/provider-preferences.dto';
import type { UpdateMarketerSettingsInput } from '../dtos/marketer-settings.dto';
import { assertEmailOptionMayChange } from './optional-email-gate';

/**
 * The marketer's settings live in the account's single notification_preferences.settings JSON (no migration), under keys that cannot collide with the client or provider
 * pages: channel_in_app / channel_email (shared switches, same keys the delivery logic reads), marketer_new_referral / marketer_new_commission (per event) and
 * marketer_communication_language / marketer_timezone. A save MERGES into the JSON, so another role's keys survive.
 */
export const MARKETER_SETTINGS_KEYS = {
  inApp: 'channel_in_app',
  email: 'channel_email',
  newReferral: 'marketer_new_referral',
  newCommission: 'marketer_new_commission',
  communicationLanguage: 'marketer_communication_language',
  timezone: 'marketer_timezone'
} as const;

const asRecord = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {});

export function toMarketerSettings(settings: unknown) {
  const s = asRecord(settings);
  const inApp = s[MARKETER_SETTINGS_KEYS.inApp] ?? s.inApp;
  const email = s[MARKETER_SETTINGS_KEYS.email] ?? s.email;
  const tz = s[MARKETER_SETTINGS_KEYS.timezone];
  return {
    // nothing saved: in-app push on, e-mail off (the same default the delivery logic applies)
    inApp: inApp !== false,
    email: email === true,
    newReferral: s[MARKETER_SETTINGS_KEYS.newReferral] !== false,
    newCommission: s[MARKETER_SETTINGS_KEYS.newCommission] !== false,
    communicationLanguage: s[MARKETER_SETTINGS_KEYS.communicationLanguage] === 'en' ? 'en' : 'ar',
    timezone: typeof tz === 'string' && (TIMEZONES as readonly string[]).includes(tz) ? tz : null
  };
}

export const marketerSettingsService = {
  async get(userId: string) {
    const row = await prisma.notificationPreference.findUnique({ where: { userId }, select: { settings: true } });
    return toMarketerSettings(row?.settings);
  },

  async update(userId: string, input: UpdateMarketerSettingsInput) {
    const row = await prisma.notificationPreference.findUnique({ where: { userId }, select: { settings: true } });
    const merged: Record<string, unknown> = { ...asRecord(row?.settings) };
    // platform OFF: the e-mail option cannot be switched ON (409); the stored value is not touched by a refused request
    if (typeof input.email === 'boolean') await assertEmailOptionMayChange(input.email, toMarketerSettings(row?.settings).email);
    for (const [field, key] of Object.entries(MARKETER_SETTINGS_KEYS)) {
      const value = (input as Record<string, unknown>)[field];
      if (value === null) delete merged[key]; // timezone back to "حسب جهازي": no value saved
      else if (value !== undefined) merged[key] = value;
    }
    const saved = await prisma.notificationPreference.upsert({
      where: { userId },
      create: { userId, settings: merged as any },
      update: { settings: merged as any },
      select: { settings: true }
    });
    return toMarketerSettings(saved.settings);
  }
};
