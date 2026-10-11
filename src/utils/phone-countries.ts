// A phone is stored as phoneCountryCode ("+20") + phoneNumber (NATIONAL digits: no "+", no country code, no trunk zero). The pair must be a real number OF THAT
// COUNTRY (libphonenumber metadata): an Egyptian number never goes with +966, a Saudi one never with +20. This is the one place that rule lives (writes and reads).
import { parsePhoneNumberFromString } from 'libphonenumber-js/mobile';

export interface ContactPhone { countryCode: string; nationalNumber: string; display: string; consistent: boolean }

const digitsOf = (v: unknown) => String(v ?? '').replace(/\D/g, '');
const clean = (v: unknown) => String(v ?? '').replace(/[\s()-]/g, '');
const DEFAULT_CC = '966';

/** "+966" / "966" / null -> "966" (the platform default, the column default). */
export function callingDigits(code: unknown): string {
	return digitsOf(code) || DEFAULT_CC;
}

/** True when `national` is a valid number of the country that owns this calling code. */
export function isValidNationalNumber(callingCode: unknown, national: string): boolean {
	const cc = callingDigits(callingCode);
	if (!/^\d{4,14}$/.test(national)) return false;
	const p = parsePhoneNumberFromString(`+${cc}${national}`);
	return !!p && p.isValid() && String(p.countryCallingCode) === cc;
}

function fromInternational(rawDigits: string): { countryCode: string; national: string } | null {
	const p = parsePhoneNumberFromString(`+${rawDigits}`);
	return p && p.isValid() ? { countryCode: `+${p.countryCallingCode}`, national: String(p.nationalNumber) } : null;
}

const stripTrunkZero = (n: string) => (n.startsWith('0') ? n.slice(1) : n);

/**
 * What a user typed (and the country they selected) -> the stored pair. Accepts the national number, the number with its calling code, or the full
 * "+CC..." number (the "+" form decides the country). Throws INVALID_PHONE when it is not a real number of that country, never stores a mismatched pair.
 */
export function normalizePhone(input: unknown, selectedCountryCode?: unknown): { countryCode: string; nationalNumber: string } {
	const raw = clean(input);
	if (!/^\+?\d+$/.test(raw)) throw new Error('INVALID_PHONE');
	if (raw.startsWith('+')) {
		const full = fromInternational(raw.slice(1));
		if (!full) throw new Error('INVALID_PHONE');
		return { countryCode: full.countryCode, nationalNumber: full.national };
	}
	const hasSelected = selectedCountryCode !== undefined && selectedCountryCode !== null && String(selectedCountryCode).trim() !== '';
	const cc = callingDigits(selectedCountryCode);
	const national = stripTrunkZero(raw);
	if (isValidNationalNumber(cc, national)) return { countryCode: `+${cc}`, nationalNumber: national };
	if (raw.startsWith(cc) && isValidNationalNumber(cc, stripTrunkZero(raw.slice(cc.length)))) return { countryCode: `+${cc}`, nationalNumber: stripTrunkZero(raw.slice(cc.length)) };
	// Only when no country was chosen explicitly may the digits themselves decide it ("201025073026" pasted without "+").
	if (!hasSelected) {
		const full = fromInternational(raw);
		if (full) return { countryCode: full.countryCode, nationalNumber: full.national };
	}
	throw new Error('INVALID_PHONE');
}

/**
 * Stored pair -> the pair to show. A consistent row is returned as is; an older inconsistent one (a full international number kept in phoneNumber, a
 * leading zero, an Egyptian number saved next to +966) is repaired for display from the digits themselves. consistent=false when it cannot be.
 */
export function canonicalStoredPhone(countryCode: unknown, stored: unknown): ContactPhone {
	const raw = clean(stored).replace(/^\+/, '');
	const shown = (cc: string, n: string, consistent: boolean): ContactPhone => ({ countryCode: `+${cc}`, nationalNumber: n, display: n ? `+${cc} ${n}` : '', consistent });
	if (!raw) return shown(callingDigits(countryCode), '', true);
	const cc = callingDigits(countryCode);
	const own = stripTrunkZero(raw);
	if (isValidNationalNumber(cc, own)) return shown(cc, own, !clean(stored).startsWith('+') && own === raw);
	if (raw.startsWith(cc) && isValidNationalNumber(cc, stripTrunkZero(raw.slice(cc.length)))) return shown(cc, stripTrunkZero(raw.slice(cc.length)), false);
	const full = fromInternational(raw);
	if (full) return shown(full.countryCode.slice(1), full.national, false);
	return shown(cc, own, false);
}
