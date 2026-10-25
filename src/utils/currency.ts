import { AppError } from './app-error';

/**
 * Money is always (amount, currency). The currencies the infrastructure supports are USD and SAR; being supported here does NOT enable one anywhere (a gateway, a wallet top-up or a
 * contract in SAR stays impossible until the payment path for it exists and is switched on). Nothing in this module converts: converting needs a RECORDED rate (fx_conversions) that
 * a human supplied, and phase 1 has no cross-currency operation at all.
 */
export const SUPPORTED_CURRENCIES = ['USD', 'SAR'] as const;
export type Currency = typeof SUPPORTED_CURRENCIES[number];
/** the platform's historical (and default) currency */
export const LEGACY_CURRENCY: Currency = 'USD';
/** minor-unit digits per currency (both are 2 today; kept per currency so a 3-digit currency cannot be rounded wrongly later) */
export const MINOR_UNITS: Record<Currency, number> = { USD: 2, SAR: 2 };

export const CURRENCY_UNSUPPORTED = 'CURRENCY_UNSUPPORTED';
export const CROSS_CURRENCY_UNSUPPORTED = 'CROSS_CURRENCY_UNSUPPORTED';
export const GATEWAY_CURRENCY_UNSUPPORTED = 'GATEWAY_CURRENCY_UNSUPPORTED';

export const isSupportedCurrency = (c: unknown): c is Currency => typeof c === 'string' && (SUPPORTED_CURRENCIES as readonly string[]).includes(c);

/** a supported currency code, or a clear 400 (never a silent default) */
export function requireCurrency(c: unknown, what = 'العملة'): Currency {
	if (!isSupportedCurrency(c)) throw new AppError(`${what} غير مدعومة: ${String(c)}. المدعوم: ${SUPPORTED_CURRENCIES.join('، ')}.`, 400, undefined, CURRENCY_UNSUPPORTED);
	return c;
}

/** Phase 1 has no cross-currency contract, escrow, release, refund or settlement: two records that meet must share a currency, else a clear 409 BEFORE anything is created or moved. */
export function assertSameCurrency(a: string | null | undefined, b: string | null | undefined, what: string): void {
	const x = a ?? LEGACY_CURRENCY, y = b ?? LEGACY_CURRENCY;
	if (x !== y) throw new AppError(`${what}: عملتان مختلفتان (${x} و${y}). المعاملات العابرة للعملات غير مدعومة حاليًا، ولا يتم أي تحويل تلقائي.`, 409, [{ from: x, to: y }], CROSS_CURRENCY_UNSUPPORTED);
}

/** round to the currency's minor units (half away from zero, with an epsilon so 1.005 behaves like money) */
export function roundMoney(n: number, currency: string = LEGACY_CURRENCY): number {
	const d = MINOR_UNITS[currency as Currency] ?? 2; const f = 10 ** d;
	return Math.sign(n) * Math.round((Math.abs(n) + Number.EPSILON) * f) / f;
}

/** Sums per currency. Never one total across currencies. */
export function sumByCurrency<T>(rows: readonly T[], currencyOf: (r: T) => string | null | undefined, amountOf: (r: T) => number | null | undefined): Record<string, number> {
	const out: Record<string, number> = {};
	for (const r of rows) { const c = currencyOf(r) ?? LEGACY_CURRENCY; out[c] = roundMoney((out[c] ?? 0) + (amountOf(r) ?? 0), c); }
	return out;
}
/** The total of rows that must all be in ONE currency, else a clear failure instead of a wrong number. */
export function singleCurrencyTotal<T>(rows: readonly T[], currencyOf: (r: T) => string | null | undefined, amountOf: (r: T) => number | null | undefined, what: string): { currency: Currency; total: number } {
	const by = sumByCurrency(rows, currencyOf, amountOf); const cs = Object.keys(by);
	if (cs.length > 1) throw new AppError(`${what}: السجلات بعملات مختلفة (${cs.join('، ')}) ولا يمكن جمعها دون سعر تحويل مسجّل.`, 409, undefined, CROSS_CURRENCY_UNSUPPORTED);
	return { currency: requireCurrency(cs[0] ?? LEGACY_CURRENCY), total: by[cs[0] ?? LEGACY_CURRENCY] ?? 0 };
}

const LOCALES: Record<string, string> = { ar: 'ar-SA-u-nu-latn', en: 'en-US' };
/** The ONE way an amount becomes text: the record's own currency, 2 digits, Latin numerals. (The FE has the same function; neither ever prints a bare "$".) */
export function formatMoney(value: number, currency: string = LEGACY_CURRENCY, lang: 'ar' | 'en' = 'ar'): string {
	const c = isSupportedCurrency(currency) ? currency : LEGACY_CURRENCY; const d = MINOR_UNITS[c];
	return new Intl.NumberFormat(LOCALES[lang], { style: 'currency', currency: c, currencyDisplay: 'code', minimumFractionDigits: d, maximumFractionDigits: d }).format(value);
}
