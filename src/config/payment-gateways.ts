import { AppError } from '../utils/app-error';
import { Currency, GATEWAY_CURRENCY_UNSUPPORTED, isSupportedCurrency } from '../utils/currency';

/**
 * What each payment gateway can take, per currency. A gateway accepts ONLY the currencies listed AND enabled here; an operation in any other currency is refused BEFORE a payment is created.
 * Supporting a currency in the platform (utils/currency.ts) never enables a gateway, and changing the base-currency setting never touches this map. A gateway with no deposit bounds for a
 * currency cannot be enabled for it: nobody invents limits. ARB / Neoleap is listed so the rule is explicit, and stays OFF (no environment enables it from here).
 */
export interface GatewayCurrency { enabled: boolean; /** deposit bounds in THIS currency; null = not decided yet (the gateway cannot be enabled for the currency) */ bounds: { min: number; max: number } | null }
export interface GatewayCapability { label: string; currencies: Partial<Record<Currency, GatewayCurrency>> }

export const PAYMENT_GATEWAYS: Record<string, GatewayCapability> = {
	paypal: { label: 'PayPal', currencies: { USD: { enabled: true, bounds: { min: 50, max: 100000 } } } },
	arb: { label: 'الراجحي / نيوليب', currencies: { SAR: { enabled: false, bounds: null } } },
};

export const gatewayAccepts = (gateway: string, currency: string): boolean => {
	const c = PAYMENT_GATEWAYS[gateway]?.currencies[currency as Currency];
	return !!c && c.enabled && c.bounds !== null;
};
export function gatewayBounds(gateway: string, currency: string): { min: number; max: number } {
	if (!gatewayAccepts(gateway, currency)) throw unsupported(gateway, currency);
	return PAYMENT_GATEWAYS[gateway].currencies[currency as Currency]!.bounds!;
}
const unsupported = (gateway: string, currency: string) => new AppError(
	`${PAYMENT_GATEWAYS[gateway]?.label ?? gateway} لا يقبل الإيداع بعملة ${currency} حاليًا. العملات المتاحة: ${enabledCurrencies(gateway).join('، ') || 'لا شيء'}.`, 400, [{ gateway, currency }], GATEWAY_CURRENCY_UNSUPPORTED);
export const enabledCurrencies = (gateway: string): string[] => Object.entries(PAYMENT_GATEWAYS[gateway]?.currencies ?? {}).filter(([, v]) => v!.enabled && v!.bounds).map(([k]) => k);
/** refuses (400, before anything is created) a currency the gateway does not take */
export function assertGatewayAccepts(gateway: string, currency: string): void {
	if (!isSupportedCurrency(currency) || !gatewayAccepts(gateway, currency)) throw unsupported(gateway, currency);
}
/** what the client may offer to a user: enabled gateways with their currencies and bounds (the FE renders it; it never types a limit) */
export function depositConfig() {
	return Object.entries(PAYMENT_GATEWAYS).map(([id, g]) => ({ id, label: g.label, currencies: Object.entries(g.currencies).filter(([, v]) => v!.enabled && v!.bounds).map(([cur, v]) => ({ currency: cur, min: v!.bounds!.min, max: v!.bounds!.max })) })).filter(g => g.currencies.length);
}
