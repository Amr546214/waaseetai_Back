import { sanitizeText } from './sanitize-text';

/**
 * The LEGAL name: the person's real name as written on the identity document. It is separate from the display name (firstName/lastName).
 * Normalisation here is deliberately conservative: it only removes what is never part of a name's identity (markup, control characters, invisible
 * characters, Arabic diacritics and kashida, repeated spaces). It never merges different letters (ا/أ/إ, ي/ى, ة/ه stay as typed) and never
 * approximates, so two different people are never treated as the same person because their names look alike.
 */
export const LEGAL_NAME_MAX = 120;
const INVISIBLE = /[​-‏‪-‮⁠﻿]/g;
const ARABIC_MARKS = /[ً-ٰٟـ]/g; // tashkeel, dagger alef, tatweel
const NAME_CHARS = /^[\p{Script=Arabic}\p{Script=Latin}][\p{Script=Arabic}\p{Script=Latin} '’.\-]*$/u;
const ARABIC_DIGITS = /[٠-٩۰-۹\d]/;

/** The value that is stored and shown to the owner / reviewers: sanitised, invisible characters removed, spaces collapsed. */
export function cleanLegalName(raw: unknown): string {
	return sanitizeText(String(raw ?? '')).replace(INVISIBLE, '').normalize('NFC').replace(/\s+/g, ' ').trim();
}

export type LegalNameCheck = { ok: true; value: string } | { ok: false; code: 'LEGAL_NAME_REQUIRED' | 'LEGAL_NAME_TOO_SHORT' | 'LEGAL_NAME_TOO_LONG' | 'LEGAL_NAME_INVALID_CHARS' | 'LEGAL_NAME_NEEDS_TWO_PARTS'; message: string };

/** A legal name needs at least two name parts (first + family), letters only (Arabic or Latin), no digits or symbols. */
export function checkLegalName(raw: unknown): LegalNameCheck {
	const value = cleanLegalName(raw);
	if (!value) return { ok: false, code: 'LEGAL_NAME_REQUIRED', message: 'الاسم الحقيقي مطلوب (كما هو مكتوب في وثيقة الهوية).' };
	if (value.length > LEGAL_NAME_MAX) return { ok: false, code: 'LEGAL_NAME_TOO_LONG', message: `الاسم الحقيقي يجب ألا يزيد على ${LEGAL_NAME_MAX} حرفًا.` };
	if (ARABIC_DIGITS.test(value) || !NAME_CHARS.test(value)) return { ok: false, code: 'LEGAL_NAME_INVALID_CHARS', message: 'الاسم الحقيقي يقبل حروفًا عربية أو لاتينية فقط، دون أرقام أو رموز.' };
	const parts = value.split(' ').filter(p => p.replace(/[^\p{L}]/gu, '').length >= 2);
	if (value.replace(/[^\p{L}]/gu, '').length < 4) return { ok: false, code: 'LEGAL_NAME_TOO_SHORT', message: 'الاسم الحقيقي قصير جدًا.' };
	if (parts.length < 2) return { ok: false, code: 'LEGAL_NAME_NEEDS_TWO_PARTS', message: 'اكتب الاسم الحقيقي من جزأين على الأقل (الاسم الأول واسم العائلة) كما في الهوية.' };
	return { ok: true, value };
}

/** Stable text of a legal name for equality / digests only (diacritics and kashida removed, case folded for Latin). Not a fuzzy match: different letters stay different. */
export function legalNameKey(raw: unknown): string {
	return cleanLegalName(raw).replace(ARABIC_MARKS, '').toLocaleLowerCase('en');
}

export const sameLegalName = (a: unknown, b: unknown) => legalNameKey(a) !== '' && legalNameKey(a) === legalNameKey(b);
