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
 *  ARB_DEPOSIT_FEE_PERCENT     ONE flat fee percent charged to the user on top of the net (may be 0). No default: it must come from an approved policy.
 *                              (The 4.25 / 5.5 % in utils/fee-policy.ts are the INTERNAL finance sheet's wallet-deposit classes, not a bank/merchant contract; this rail does not read them.)
 *  ARB_ALLOWED_USER_IDS        comma list of user ids that may use the rail (UAT: QA accounts only); 'ALL' opens it to everyone (a later, explicit decision)
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
	/** flat fee percent over the net, from an approved policy; null = not decided */
	feePercent: number | null;
	/** user ids allowed to use the rail; 'ALL' = everyone (only by explicit decision) */
	allowedUserIds: string[];
	notificationEnabled: boolean;
	currencyCode: '682';
	/** ms, whole bank HTTP call */
	httpTimeoutMs: number;
	/** minutes an attempt may stay open before it is treated as expired (soft) */
	attemptTtlMin: number;
}

export function loadArbConfig(env: NodeJS.ProcessEnv = process.env): ArbConfig {
	const feeRaw = (env.ARB_DEPOSIT_FEE_PERCENT ?? '').trim();
	const fee = feeRaw === '' ? NaN : Number(feeRaw);
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
		feePercent: Number.isFinite(fee) && fee >= 0 && fee < 50 ? fee : null,
		allowedUserIds: (env.ARB_ALLOWED_USER_IDS || '').split(',').map(x => x.trim()).filter(Boolean),
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
	if (c.feePercent === null) miss.push('ARB_DEPOSIT_FEE_PERCENT');
	if (c.allowedUserIds.length === 0) miss.push('ARB_ALLOWED_USER_IDS');
	return miss;
}

/** whether this user may use the rail (UAT = a short list of QA ids; 'ALL' only by explicit decision) */
export function arbAllowsUser(c: ArbConfig, userId: string): boolean {
	return c.allowedUserIds.includes('ALL') || c.allowedUserIds.includes(userId);
}

/** Presence only: which settings exist, no values. Safe to log / print. */
export function describeArbConfig(c: ArbConfig): Record<string, boolean | string[]> {
	return { enabled: c.enabled, missing: missingArbSettings(c), notificationEnabled: c.notificationEnabled };
}
