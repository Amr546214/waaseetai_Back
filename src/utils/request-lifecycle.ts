// One place that turns the REAL server fields of a client request (ClientRequest.status, the contract's status, the escrow, the offers' statuses)
// into the state the client sees. Nothing here is stored: a request is never shown as running before the contract is signed AND funded.

export type RequestStage =
	| 'DRAFT' | 'OPEN' | 'OFFERS_RECEIVED' | 'UNDER_NEGOTIATION'
	| 'AWAITING_CLIENT_SIGNATURE' | 'AWAITING_FUNDING' | 'AWAITING_PROVIDER_SIGNATURE'
	| 'ACTIVE' | 'COMPLETED' | 'CANCELLED' | 'DISPUTED';

/** The groups the requests list tabs count (every stage belongs to exactly one). */
export type RequestStageGroup = 'draft' | 'open' | 'pending' | 'active' | 'closed';

export const REQUEST_STAGE_LABEL: Record<RequestStage, string> = {
	DRAFT: 'مسودة',
	OPEN: 'مفتوح لاستقبال العروض',
	OFFERS_RECEIVED: 'وصلتك عروض',
	UNDER_NEGOTIATION: 'قيد التفاوض',
	AWAITING_CLIENT_SIGNATURE: 'تم اختيار العرض، بانتظار توقيعك وتمويل الضمان',
	AWAITING_FUNDING: 'بانتظار تمويل الضمان',
	AWAITING_PROVIDER_SIGNATURE: 'بانتظار توقيع مقدم الخدمة',
	ACTIVE: 'قيد التنفيذ',
	COMPLETED: 'مكتمل',
	CANCELLED: 'ملغي',
	DISPUTED: 'نزاع مفتوح'
};

export const REQUEST_STAGE_GROUP: Record<RequestStage, RequestStageGroup> = {
	DRAFT: 'draft',
	OPEN: 'open',
	OFFERS_RECEIVED: 'open',
	UNDER_NEGOTIATION: 'open',
	AWAITING_CLIENT_SIGNATURE: 'pending',
	AWAITING_FUNDING: 'pending',
	AWAITING_PROVIDER_SIGNATURE: 'pending',
	ACTIVE: 'active',
	COMPLETED: 'closed',
	CANCELLED: 'closed',
	DISPUTED: 'active'
};

// offer statuses that still count as a live offer on an OPEN request
const LIVE_OFFER = ['PENDING', 'SUBMITTED', 'UNDER_NEGOTIATION'];

export interface RequestLifecycleInput {
	requestStatus: string | null | undefined;
	contractStatus?: string | null;
	offerStatuses?: Array<string | null | undefined>;
}

export function deriveRequestStage(input: RequestLifecycleInput): RequestStage {
	const status = String(input.requestStatus || '').toUpperCase();
	const contract = String(input.contractStatus || '').toUpperCase();
	if (status === 'DRAFT') return 'DRAFT';
	if (status === 'CANCELLED') return 'CANCELLED';
	if (status === 'COMPLETED' || contract === 'COMPLETED') return 'COMPLETED';
	if (contract === 'DISPUTED') return 'DISPUTED';
	if (status === 'IN_PROGRESS') {
		// the request only moves to IN_PROGRESS once both parties signed and the escrow is held; any other contract state keeps it waiting
		if (contract === 'PENDING_PAYMENT') return 'AWAITING_FUNDING';
		if (contract === 'PENDING_CLIENT_SIGNATURE') return 'AWAITING_CLIENT_SIGNATURE';
		if (contract === 'PENDING_PROVIDER_SIGNATURE') return 'AWAITING_PROVIDER_SIGNATURE';
		return 'ACTIVE';
	}
	if (status === 'PENDING_SIGNATURE') {
		if (contract === 'PENDING_PAYMENT') return 'AWAITING_FUNDING';
		if (contract === 'PENDING_PROVIDER_SIGNATURE') return 'AWAITING_PROVIDER_SIGNATURE';
		if (contract === 'ACTIVE') return 'ACTIVE';
		return 'AWAITING_CLIENT_SIGNATURE';
	}
	const offers = (input.offerStatuses || []).map(s => String(s || '').toUpperCase());
	if (offers.includes('UNDER_NEGOTIATION')) return 'UNDER_NEGOTIATION';
	if (offers.some(s => LIVE_OFFER.includes(s))) return 'OFFERS_RECEIVED';
	return 'OPEN';
}

/** Why an action on one offer is not available (null = available). Ordered: the most fundamental reason first. */
export function offerActionBlock(requestStatus: string | null | undefined, offerStatus: string | null | undefined): string | null {
	const rs = String(requestStatus || '').toUpperCase();
	const os = String(offerStatus || '').toUpperCase();
	if (rs === 'CANCELLED') return 'تم إلغاء هذا الطلب';
	if (rs === 'COMPLETED') return 'اكتمل هذا الطلب';
	if (rs === 'IN_PROGRESS') return 'المشروع قيد التنفيذ ولا يمكن تغيير العرض';
	if (rs === 'PENDING_SIGNATURE') return os === 'PENDING_SIGNATURE' ? 'تم اختيار هذا العرض وينتظر التوقيع والضمان' : 'تم اختيار عرض آخر لهذا الطلب';
	if (rs === 'DRAFT') return 'الطلب مسودة ولم يُنشر بعد';
	if (os === 'CANCELLED') return 'سحب مقدم الخدمة هذا العرض';
	if (os === 'REJECTED') return 'هذا العرض مغلق';
	if (os === 'ACCEPTED' || os === 'PENDING_SIGNATURE') return 'تم اختيار هذا العرض مسبقًا';
	if (os === 'DRAFT' || os === 'IN_AI_REVIEW') return 'هذا العرض لم يكتمل بعد';
	return null;
}
