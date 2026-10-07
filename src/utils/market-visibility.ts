// AUD-FND-000049 / 000050 — what the public marketplace may show. A published service is shown only while BOTH hold:
//  • its provider's kycStatus is VERIFIED (ProviderProfile.kycStatus);
//  • the specialty behind its accreditation sample is APPROVED (ProviderSpecialty.status).
// Nothing is deleted or rewritten: a service that stops meeting either condition simply leaves the market (it stays in the owner's dashboard,
// shown as "under review" with the reason) and returns by itself the moment both hold again, because the gate is evaluated on every read.
export const MARKET_PUBLISHED_STATUSES = ['PUBLISHED', 'APPROVED'] as const;

export const MARKET_VISIBLE_WHERE = {
	status: { in: [...MARKET_PUBLISHED_STATUSES] as any },
	AND: [
		{ provider: { providerProfile: { kycStatus: 'VERIFIED' as any } } },
		{ accreditationSample: { providerSpecialty: { status: 'APPROVED' as any } } }
	]
};

export type MarketEligibilityInput = {
	provider?: { providerProfile?: { kycStatus?: string | null } | null } | null;
	accreditationSample?: { providerSpecialty?: { status?: string | null } | null } | null;
};

export const MARKET_ELIGIBILITY_SELECT_PROVIDER = { kycStatus: true } as const;

export type MarketBlockReason = 'KYC_NOT_VERIFIED' | 'SPECIALTY_NOT_APPROVED';

/** The reasons a service is kept off the market (empty = visible). Mirrors MARKET_VISIBLE_WHERE for rows already loaded. */
export function marketBlockReasons(service: MarketEligibilityInput): MarketBlockReason[] {
	const reasons: MarketBlockReason[] = [];
	if (service.provider?.providerProfile?.kycStatus !== 'VERIFIED') reasons.push('KYC_NOT_VERIFIED');
	if (service.accreditationSample?.providerSpecialty?.status !== 'APPROVED') reasons.push('SPECIALTY_NOT_APPROVED');
	return reasons;
}

export const MARKET_BLOCK_MESSAGES: Record<MarketBlockReason, string> = {
	KYC_NOT_VERIFIED: 'لا تظهر هذه الخدمة في السوق لأن توثيق هويتك لم يكتمل بعد. تظهر تلقائيًا بعد اعتماد التوثيق.',
	SPECIALTY_NOT_APPROVED: 'لا تظهر هذه الخدمة في السوق لأن التخصص المرتبط بها غير معتمد بعد. تظهر تلقائيًا بعد اعتماد التخصص.'
};

export const marketBlockMessage = (reasons: MarketBlockReason[]) => reasons.map(r => MARKET_BLOCK_MESSAGES[r]).join(' ');
