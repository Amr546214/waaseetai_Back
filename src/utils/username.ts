import { sanitizeText } from './sanitize-text';

/**
 * The username: the name a person uses to deal with others and to appear on the platform. ONE field, a single word is fine (e.g. «عمرو»). Not unique (a first name is common), not a login
 * identifier, never the legal name. Letters (Arabic or Latin), digits, spaces, `_`, `.`, `-`; no markup, no links, no addresses.
 */
export const USERNAME_MIN = 2;
export const USERNAME_MAX = 60;
const INVISIBLE = /[​-‏‪-‮⁠﻿]/g;
const ALLOWED = /^[\p{Script=Arabic}\p{Script=Latin}\d٠-٩][\p{Script=Arabic}\p{Script=Latin}\d٠-٩ _.\-]*$/u;

export const cleanUsername = (raw: unknown): string => sanitizeText(String(raw ?? '')).replace(INVISIBLE, '').normalize('NFC').replace(/\s+/g, ' ').trim();

export type UsernameCheck = { ok: true; value: string } | { ok: false; code: 'USERNAME_REQUIRED' | 'USERNAME_TOO_SHORT' | 'USERNAME_TOO_LONG' | 'USERNAME_INVALID_CHARS'; message: string };
export function checkUsername(raw: unknown): UsernameCheck {
	const value = cleanUsername(raw);
	if (!value) return { ok: false, code: 'USERNAME_REQUIRED', message: 'اسم المستخدم مطلوب.' };
	if (value.length > USERNAME_MAX) return { ok: false, code: 'USERNAME_TOO_LONG', message: `اسم المستخدم يجب ألا يزيد على ${USERNAME_MAX} حرفًا.` };
	if (!ALLOWED.test(value) || /[@/\\]|https?:|www\./i.test(value)) return { ok: false, code: 'USERNAME_INVALID_CHARS', message: 'اسم المستخدم يقبل حروفًا عربية أو لاتينية وأرقامًا ومسافة و _ . - فقط، دون روابط أو رموز.' };
	if (value.replace(/[^\p{L}]/gu, '').length < USERNAME_MIN) return { ok: false, code: 'USERNAME_TOO_SHORT', message: 'اسم المستخدم قصير جدًا.' };
	return { ok: true, value };
}

/** What the platform shows for a person: the username when chosen, else the older first/last name. */
export const displayNameOf = (u: { username?: string | null; firstName?: string | null; lastName?: string | null }): string => (u.username?.trim() || `${u.firstName ?? ''} ${u.lastName ?? ''}`.trim());
