import { DepositMethod, DEPOSIT_FEE_PERCENT } from '../utils/fee-policy';

/**
 * ARB / Neoleap (Al Rajhi) payment-gateway settings. EVERYTHING comes from the server environment; there are no defaults for anything the bank or the
 * owner decides (endpoints, credentials, currency rate, fee class). A missing item makes the feature report "not configured" instead of guessing.
 * Secrets (Tranportal password, Resource Key) are only returned inside the object handed to the crypto/client code; `describe()` never contains values.
 *
 *  ARB_ENABLED                 'true' to turn the feature on (default off)
 *  ARB_TRANPORTAL_ID           Tranportal id            (secret-ish, server only)
 *  ARB_TRANPORTAL_PASSWORD     Tranportal password      (secret)
 *  ARB_RESOURCE_KEY            Resource Key, 16/24/32 chars (secret)
 *  ARB_HOSTED_TOKEN_URL        full https URL of the Bank-Hosted "Payment Token Generation" endpoint, exactly as the bank sent it
 *  ARB_INQUIRY_URL             full https URL of the supporting-transaction (Inquiry action 8) endpoint, exactly as the bank sent it
 *  ARB_ALLOWED_HOSTS           comma list of host names the bank may send users to / that we may call (e.g. the host of the two URLs above)
 *  ARB_PUBLIC_BASE_URL         https origin of THIS environment (builds responseURL / errorURL)
 *  ARB_SAR_PER_USD             owner-approved conversion (SAR per 1 USD) — the wallet is USD, the bank currency code in the guide is 682 (SAR)
 *  ARB_FEE_METHOD              'mada' | 'visa_mastercard' — which deposit-fee class of fee-policy v2 applies to this rail
 *  ARB_NOTIFICATION_ENABLED    'true' only if the bank enabled merchant notification (webhook) for this merchant
 */
export interface ArbConfig {
	enabled: boolean;
	tranportalId: string;
	tranportalPassword: string;
	resourceKey: string;
	hostedTokenUrl: string;
	inquiryUrl: string;
	allowedHosts: string[];
	publicBaseUrl: string;
	sarPerUsd: number;
	feeMethod: DepositMethod;
	notificationEnabled: boolean;
	currencyCode: '682';
	/** ms, whole bank HTTP call */
	httpTimeoutMs: number;
	/** minutes an attempt may stay open before it is treated as expired (soft) */
	attemptTtlMin: number;
}

const FEE_METHODS: DepositMethod[] = ['mada', 'visa_mastercard'];

export function loadArbConfig(env: NodeJS.ProcessEnv = process.env): ArbConfig {
	const fee = (env.ARB_FEE_METHOD || '').trim() as DepositMethod;
	const rate = Number((env.ARB_SAR_PER_USD || '').trim());
	return {
		enabled: (env.ARB_ENABLED || '').trim() === 'true',
		tranportalId: (env.ARB_TRANPORTAL_ID || '').trim(),
		tranportalPassword: env.ARB_TRANPORTAL_PASSWORD || '',
		resourceKey: env.ARB_RESOURCE_KEY || '',
		hostedTokenUrl: (env.ARB_HOSTED_TOKEN_URL || '').trim(),
		inquiryUrl: (env.ARB_INQUIRY_URL || '').trim(),
		allowedHosts: (env.ARB_ALLOWED_HOSTS || '').split(',').map(h => h.trim().toLowerCase()).filter(Boolean),
		publicBaseUrl: (env.ARB_PUBLIC_BASE_URL || '').trim().replace(/\/+$/, ''),
		sarPerUsd: Number.isFinite(rate) && rate > 0 ? rate : 0,
		feeMethod: FEE_METHODS.includes(fee) ? fee : ('other' as DepositMethod),
		notificationEnabled: (env.ARB_NOTIFICATION_ENABLED || '').trim() === 'true',
		currencyCode: '682',
		httpTimeoutMs: 20_000,
		attemptTtlMin: 30,
	};
}

/** Names of the settings that are still missing (never their values). */
export function missingArbSettings(c: ArbConfig): string[] {
	const miss: string[] = [];
	if (!c.tranportalId) miss.push('ARB_TRANPORTAL_ID');
	if (!c.tranportalPassword) miss.push('ARB_TRANPORTAL_PASSWORD');
	if (![16, 24, 32].includes(Buffer.byteLength(c.resourceKey, 'utf8'))) miss.push('ARB_RESOURCE_KEY');
	if (!/^https:\/\//i.test(c.hostedTokenUrl)) miss.push('ARB_HOSTED_TOKEN_URL');
	if (!/^https:\/\//i.test(c.inquiryUrl)) miss.push('ARB_INQUIRY_URL');
	if (c.allowedHosts.length === 0) miss.push('ARB_ALLOWED_HOSTS');
	if (!/^https:\/\/[^/]+$/i.test(c.publicBaseUrl)) miss.push('ARB_PUBLIC_BASE_URL');
	if (!(c.sarPerUsd > 0)) miss.push('ARB_SAR_PER_USD');
	if (!FEE_METHODS.includes(c.feeMethod)) miss.push('ARB_FEE_METHOD');
	return miss;
}

export function arbFeePercent(c: ArbConfig): number {
	return DEPOSIT_FEE_PERCENT[c.feeMethod];
}

/** Presence only: which settings exist, no values. Safe to log / print. */
export function describeArbConfig(c: ArbConfig): Record<string, boolean | string[]> {
	return { enabled: c.enabled, missing: missingArbSettings(c), notificationEnabled: c.notificationEnabled };
}
