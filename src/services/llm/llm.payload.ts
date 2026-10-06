// Payload construction for the LLM layer: ALLOWLIST only (a field not listed never leaves the server) plus regex scrubbing of
// free text. Names, emails, phones, ID numbers, addresses and personal links are not in any allowlist.

const ARABIC_INDIC = '٠١٢٣٤٥٦٧٨٩';
const EASTERN_ARABIC_INDIC = '۰۱۲۳۴۵۶۷۸۹';

/** Arabic-Indic / Persian digits → ASCII digits. */
export function normalizeDigits(text: string): string {
  return text.replace(/[٠-٩۰-۹]/g, (ch) => {
    const i = ARABIC_INDIC.indexOf(ch);
    return String(i >= 0 ? i : EASTERN_ARABIC_INDIC.indexOf(ch));
  });
}

const EMAIL_RE = /[\p{L}\p{N}._%+-]+@[\p{L}\p{N}.-]+\.[\p{L}]{2,}/gu;
const URL_RE = /\b(?:https?:\/\/|www\.)[^\s<>"')]+/gi;
// international / local phone numbers: 7+ digits, optionally separated, optional leading +
const PHONE_RE = /(?<![\d])(?:\+|00)?\d(?:[\s().-]?\d){6,}(?![\d])/g;
const HANDLE_RE = /(?<![\w@])@[A-Za-z0-9_.]{3,}/g;

/** Removes emails, URLs, phone numbers and @handles from free text. Applied to every free-text field before sending. */
export function scrubFreeText(value: string | null | undefined, maxLength = 4000): string {
  if (!value) return '';
  const digitsNormalised = normalizeDigits(String(value));
  return digitsNormalised
    .replace(EMAIL_RE, '[محجوب]')
    .replace(URL_RE, '[محجوب]')
    .replace(PHONE_RE, '[محجوب]')
    .replace(HANDLE_RE, '[محجوب]')
    .replace(/\s{3,}/g, '  ')
    .trim()
    .slice(0, maxLength);
}

export type AllowRule = 'text' | 'string' | 'number' | 'boolean' | 'date' | AllowRule[] | { [key: string]: AllowRule };

/**
 * Builds a payload keeping ONLY the fields named in `allow`. 'text' = free text (scrubbed), 'string' = short label (scrubbed
 * lightly), 'number'/'boolean' = primitives, 'date' = ISO string. Arrays are described by a one-element array rule.
 */
export function buildPayload(source: unknown, allow: AllowRule): unknown {
  if (source === null || source === undefined) return null;
  if (Array.isArray(allow)) {
    if (!Array.isArray(source)) return [];
    return source.map((item) => buildPayload(item, allow[0]));
  }
  if (typeof allow === 'string') {
    switch (allow) {
      case 'text': return typeof source === 'string' ? scrubFreeText(source) : null;
      case 'string': return typeof source === 'string' ? scrubFreeText(source, 200) : null;
      case 'number': return typeof source === 'number' && Number.isFinite(source) ? source : null;
      case 'boolean': return typeof source === 'boolean' ? source : null;
      case 'date': return source instanceof Date ? source.toISOString() : typeof source === 'string' ? source : null;
    }
  }
  if (typeof source !== 'object') return null;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(allow as object)) {
    out[key] = buildPayload((source as Record<string, unknown>)[key], (allow as Record<string, AllowRule>)[key]);
  }
  return out;
}

/** Test/guard helper: returns the first personal-data pattern found anywhere in the JSON, or null. */
export function findPersonalData(payload: unknown): string | null {
  const text = JSON.stringify(payload ?? null);
  const normalised = normalizeDigits(text);
  for (const re of [EMAIL_RE, URL_RE, PHONE_RE]) {
    re.lastIndex = 0;
    const m = re.exec(normalised);
    if (m) return m[0];
  }
  return null;
}
