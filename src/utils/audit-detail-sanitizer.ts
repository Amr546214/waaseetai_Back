/**
 * Everything the audit trail prints as «detail» goes through here. Two layers:
 *  1. ALLOW-LIST: metadata is only read through ALLOWED_META (key -> Arabic label); a key that is not listed is never shown, whatever it holds.
 *  2. REDACTION of the text itself (stored summaries are free sentences written by many callers): tokens, JWTs, links with secrets, OTP / password /
 *     key assignments, card / IBAN numbers, PayPal-style ids, long opaque strings and e-mail local parts are replaced by «[محجوب]».
 * Ids of the entities themselves (UUIDs, ISO dates) are kept: they are the event's own identity, not secrets.
 */
export const REDACTED = '[محجوب]';

export const ALLOWED_META: Record<string, string> = {
	reason: 'السبب', outcome: 'النتيجة', decision: 'القرار', party: 'الطرف', status: 'الحالة', previousStatus: 'الحالة السابقة', changedFields: 'الحقول المعدّلة', version: 'النسخة', count: 'العدد'
};

const UUID = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;
const ISO = /\b\d{4}-\d{2}-\d{2}(?:T[\d:.]+Z?)?\b/g;

export function redact(input: unknown, max = 240): string {
	let s = String(input ?? '').replace(/[\u0000-\u001F\u007F]/g, ' ').replace(/\s+/g, ' ').trim();
	if (!s) return '';
	const keep: string[] = [];
	const hold = (m: string) => { keep.push(m); return `\u0001${keep.length - 1}\u0001`; };
	s = s.replace(UUID, hold).replace(ISO, hold);
	s = s
		.replace(/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]*/g, REDACTED) // JWT
		.replace(/\bBearer\s+\S+/gi, `Bearer ${REDACTED}`)
		.replace(/https?:\/\/\S+/gi, m => (/[?&#](token|code|otp|key|secret|sig|signature|reset|session)[=]/i.test(m) || /(reset|verify|token|invite|accept)/i.test(m) ? REDACTED : m))
		.replace(/\b(password|passwd|pwd|token|secret|otp|api[_-]?key|apikey|authorization|session[_-]?id|hash|code|كلمة المرور|رمز|مفتاح)\s*[:=：]\s*\S+/gi, (_m, k) => `${k}: ${REDACTED}`)
		.replace(/\b(?:\d[ -]?){13,19}\b/g, REDACTED) // card numbers
		.replace(/\b[A-Z]{2}\d{2}[A-Z0-9]{10,30}\b/g, REDACTED) // IBAN
		.replace(/(رقم عملية\s*PayPal|PayPal\s*(?:id|capture|order|transaction)[^:]*)\s*[:：]\s*\S+/gi, (_m, k) => `${k}: ${REDACTED}`)
		.replace(/\b[A-Z0-9]{17}\b/g, REDACTED) // PayPal-style ids
		.replace(/[\w.+-]+@[\w-]+(\.[\w-]+)+/g, m => `${m.slice(0, 2)}***@${m.split('@')[1]}`)
		.replace(/\b(?=[A-Za-z0-9_-]*\d)(?=[A-Za-z0-9_-]*[A-Za-z])[A-Za-z0-9_-]{24,}\b/g, REDACTED) // long opaque strings
		.replace(/\b[0-9a-f]{32,}\b/gi, REDACTED);
	s = s.replace(/\u0001(\d+)\u0001/g, (_m, i) => keep[Number(i)]);
	return s.length > max ? `${s.slice(0, max).trim()}…` : s;
}

/** short facts from metadata, ONLY for allow-listed keys and primitive / string-array values; every value is redacted */
export function metaFacts(meta: unknown): string | null {
	if (!meta || typeof meta !== 'object' || Array.isArray(meta)) return null;
	const out: string[] = [];
	for (const [k, label] of Object.entries(ALLOWED_META)) {
		const v = (meta as Record<string, unknown>)[k];
		let txt = '';
		if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') txt = redact(v, 120);
		else if (Array.isArray(v) && v.every(x => typeof x === 'string')) txt = redact(v.slice(0, 8).join('، '), 120);
		if (txt) out.push(`${label}: ${txt}`);
	}
	return out.length ? out.join(' · ') : null;
}
