// A phone is stored as phoneCountryCode ("+966") + phoneNumber (NATIONAL digits: no "+", no country code, no leading zero).
// toNationalPhone turns what a user typed into that one shape; displayPhone is the one place that joins them back for display.

const digitsOf = (v: unknown) => String(v ?? '').replace(/\D/g, '');

/** "+966"/"966"/null -> "966" (null/empty falls back to the platform default +966, the column default). */
export function countryDigits(code: unknown): string {
	return digitsOf(code) || '966';
}

/**
 * Typed value -> national digits. A leading "+" must carry the account's own country code (changing the country here is not supported) and the
 * code is removed; a single leading zero (local trunk prefix) is removed. Throws INVALID_PHONE / INVALID_PHONE_COUNTRY.
 */
export function toNationalPhone(input: unknown, countryCode: unknown): string {
	const raw = String(input ?? '').replace(/[\s()-]/g, '');
	if (!/^\+?\d+$/.test(raw)) throw new Error('INVALID_PHONE');
	let national = raw;
	if (raw.startsWith('+')) {
		const cc = countryDigits(countryCode);
		const digits = raw.slice(1);
		if (!digits.startsWith(cc)) throw new Error('INVALID_PHONE_COUNTRY');
		national = digits.slice(cc.length);
	}
	if (national.startsWith('0')) national = national.slice(1);
	if (!/^\d{7,14}$/.test(national)) throw new Error('INVALID_PHONE');
	return national;
}

/** Stored code + stored number -> "+966 501234567" (never a doubled code, always one "+", tolerant of legacy rows with a leading 0 or a full +CC number). */
export function displayPhone(countryCode: unknown, phoneNumber: unknown): string {
	const stored = String(phoneNumber ?? '').replace(/[\s()-]/g, '');
	if (!stored) return '';
	const cc = countryDigits(countryCode);
	if (stored.startsWith('+')) return stored;
	const local = stored.startsWith('0') ? stored.slice(1) : stored;
	return `+${cc} ${local}`;
}
