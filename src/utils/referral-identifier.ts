/**
 * Cleans what a person typed or pasted as a marketer's referral code before it is looked up:
 * a full link (https://host/ref/<slug>?utm_source=x), an "@slug" handle, or a slug with stray spaces all become the bare slug.
 * Returns undefined when nothing usable is left. Matching itself (slug vs. id, case) stays in auth.service.
 */
export function normalizeReferralIdentifier(raw?: string | null): string | undefined {
	if (typeof raw !== 'string') return undefined;
	let value = raw.trim();
	if (!value) return undefined;

	const refMatch = value.match(/\/ref\/([^/?#\s]+)/i);
	if (refMatch) value = refMatch[1];
	value = value.split(/[?#]/)[0];
	try {
		value = decodeURIComponent(value);
	} catch {
		// keep the raw text: a lookup that finds nothing is the safe outcome
	}
	value = value.replace(/^@+/, '').replace(/\/+$/, '').trim();

	return value && value.length <= 100 ? value : undefined;
}
