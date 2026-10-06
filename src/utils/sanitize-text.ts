import { z } from 'zod';

// A tag (or the start of one, even when it is never closed): "<b>", "</p>", "<img src=x onerror=alert(1)". A "<" that is not followed
// by a letter, "/", "!" or "?" (for example "5 < 6" or Arabic prose) is not a tag and is left alone.
const HTML_TAG = /<\/?[a-zA-Z!?][^>]*>?/g;
// Control characters that are never part of a name or a bio (tab, LF and CR are kept).
const CONTROL_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;

/**
 * The single shared text sanitizer for free-text profile fields (names, bio, marketing handles). It STRIPS markup instead of
 * HTML-escaping it, so the stored value is plain text and is never double-escaped when Angular renders it; Arabic text is untouched.
 */
export function sanitizeText(value: string): string {
	let text = value.replace(CONTROL_CHARS, '');
	let previous: string;
	do {
		previous = text;
		text = text.replace(HTML_TAG, '');
	} while (text !== previous);
	return text;
}

/** zod: sanitize the incoming string first, then validate it (so "<b></b>" is judged as the empty text it really is). */
export const sanitizedText = <T extends z.ZodTypeAny>(inner: T) =>
	z.preprocess((value) => (typeof value === 'string' ? sanitizeText(value) : value), inner);
