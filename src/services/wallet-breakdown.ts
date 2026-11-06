import { round2 } from '../utils/money';
import { isV2Escrow } from '../utils/escrow-commission';

// «تفصيل المبالغ والخصومات»: DISPLAY-ONLY builders. Every number comes from a stored record of the operation (wallet transaction metadata, the escrow's snapshot taken at lock,
// the cancellation settlement columns, the commission snapshot). Nothing here reads a current level / current policy and nothing is written: a missing field yields
// detailsRecorded=false («تفاصيل الخصم غير مسجّلة»), never a guessed deduction.

export const MISSING_NOTE = 'تفاصيل الخصم غير مسجّلة';

export type DeductionCode = 'PAYPAL_DEPOSIT_FEE' | 'PLATFORM_PROVIDER_COMMISSION';
export interface Deduction { code: DeductionCode; label: string; amount: number; ratePercent: number | null; level: number | null; levelRecorded: boolean; reason: string }
export type NetMeaning = 'ADDED_TO_WALLET' | 'WITHDRAWABLE' | 'LOCKED_IN_ESCROW' | 'RETURNED_TO_WALLET' | 'DEBITED_FROM_WALLET' | 'COMMISSION_EARNED' | 'HELD';
export interface Breakdown {
	operation: string;
	operationLabel: string;
	currency: string;
	detailsRecorded: boolean;
	missingNote: string | null;
	gross: number | null;
	deductions: Deduction[];
	net: number | null;
	netMeaning: NetMeaning;
	note: string | null;
}

export type CardState = 'AVAILABLE' | 'UNAVAILABLE' | 'NOT_ENABLED' | 'NOT_APPLICABLE';
export interface Card { value: number | null; currency: 'USD'; state: CardState; label: string; covers: string[]; complete: boolean; operationsCounted: number; operationsWithoutDetails: number; excludedOtherCurrency: number; note: string | null }

export const stateCard = (state: Exclude<CardState, 'AVAILABLE'>, label: string, note: string): Card =>
	({ value: null, currency: 'USD', state, label, covers: [], complete: true, operationsCounted: 0, operationsWithoutDetails: 0, excludedOtherCurrency: 0, note });
export const valueCard = (label: string, value: number, extra: Partial<Card> = {}): Card =>
	({ value: round2(value), currency: 'USD', state: 'AVAILABLE', label, covers: [], complete: true, operationsCounted: 0, operationsWithoutDetails: 0, excludedOtherCurrency: 0, note: null, ...extra });

/** Sums `gross` of breakdowns over USD records only. Records without a recorded gross are counted, never guessed; other currencies are counted, never added. */
export function grossCard(label: string, covers: string[], items: Array<{ breakdown: Breakdown }>, note: string | null = null): Card {
	let total = 0; let counted = 0; let without = 0; let other = 0;
	for (const { breakdown: b } of items) {
		if (b.currency !== 'USD') { other += 1; continue; }
		if (!b.detailsRecorded || b.gross == null) { without += 1; continue; }
		total += b.gross; counted += 1;
	}
	return valueCard(label, total, { covers, operationsCounted: counted, operationsWithoutDetails: without, excludedOtherCurrency: other, complete: without === 0 && other === 0, note });
}

const base = (operation: string, operationLabel: string, currency: string, netMeaning: NetMeaning): Breakdown =>
	({ operation, operationLabel, currency, detailsRecorded: true, missingNote: null, gross: null, deductions: [], net: null, netMeaning, note: null });
const unrecorded = (b: Breakdown, net: number | null): Breakdown => ({ ...b, detailsRecorded: false, missingNote: MISSING_NOTE, gross: null, deductions: [], net });

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const meta = (m: unknown): Record<string, unknown> => (m && typeof m === 'object' && !Array.isArray(m) ? (m as Record<string, unknown>) : {});

/** Commission deduction for a provider release from the escrow's lock-time snapshot. Rate/level are the RECORDED ones; absent snapshot => null. */
const commissionDeduction = (amount: number, escrow: any): Deduction => {
	const rate = num(escrow?.providerCommissionRateSnapshot);
	const level = num(escrow?.providerCommissionLevelSnapshot);
	return {
		code: 'PLATFORM_PROVIDER_COMMISSION', label: 'عمولة المنصة', amount: round2(amount), ratePercent: rate, level, levelRecorded: level != null,
		reason: level != null && rate != null ? `عمولة المنصة حسب مستواك وقت تمويل العقد (المستوى ${level}، ${rate}%)` : 'عمولة المنصة على إفراج الدفعة'
	};
};

const CLIENT_LABELS: Record<string, string> = {
	DEPOSIT: 'إيداع في المحفظة', ESCROW_LOCK: 'تمويل ضمان المشروع', REFUND: 'استرداد إلى المحفظة', WITHDRAWAL: 'سحب', ORDER_PAYMENT: 'دفع طلب',
	AMENDMENT_TOPUP: 'زيادة ميزانية العقد', AMENDMENT_REFUND: 'استرداد خفض ميزانية العقد'
};
const NO_DEDUCTION_TYPES = new Set(['REFUND', 'WITHDRAWAL', 'ORDER_PAYMENT', 'AMENDMENT_TOPUP', 'AMENDMENT_REFUND']);

/** Breakdown of a stored WalletTransaction (client side). */
export function walletTxBreakdown(tx: { type: string; amount: number; currency: string; status?: string; paymentMethod?: string | null; metadata?: unknown }): Breakdown {
	const m = meta(tx.metadata);
	const label = CLIENT_LABELS[tx.type] ?? 'معاملة مالية';
	const abs = round2(Math.abs(tx.amount));
	if (tx.type === 'DEPOSIT') {
		const b = base('DEPOSIT', tx.paymentMethod === 'PAYPAL' ? 'إيداع عبر PayPal' : label, tx.currency, 'ADDED_TO_WALLET');
		const gross = num(m.grossCharged); const fee = num(m.feeAmount); const net = num(m.netCredited); const pct = num(m.feePercent);
		if (gross == null || fee == null || net == null) return unrecorded(b, abs);
		return { ...b, gross: round2(gross), net: round2(net), deductions: [{ code: 'PAYPAL_DEPOSIT_FEE', label: 'رسوم الإيداع (PayPal)', amount: round2(fee), ratePercent: pct, level: null, levelRecorded: false, reason: 'رسوم بوابة الدفع على الإيداع' }] };
	}
	if (tx.type === 'ESCROW_LOCK') {
		const b = base('ESCROW_LOCK', label, tx.currency, 'LOCKED_IN_ESCROW');
		if (num(m.feePolicyVersion) === 2 && num(m.escrowFee) === 0) return { ...b, gross: abs, net: abs, note: 'لا رسوم على تمويل الضمان' };
		return unrecorded(b, abs);
	}
	if (NO_DEDUCTION_TYPES.has(tx.type)) {
		const meaning: NetMeaning = tx.type === 'REFUND' || tx.type === 'AMENDMENT_REFUND' ? 'RETURNED_TO_WALLET' : 'DEBITED_FROM_WALLET';
		return { ...base(tx.type, label, tx.currency, meaning), gross: abs, net: abs };
	}
	return unrecorded(base('OTHER', label, tx.currency, 'ADDED_TO_WALLET'), abs);
}

/** Breakdown of an escrow funding that has no wallet row (the client history shows it from the escrow itself). */
export function escrowFundingBreakdown(escrow: { amount: number; feePolicyVersion?: number | null }): Breakdown {
	const b = base('ESCROW_LOCK', CLIENT_LABELS.ESCROW_LOCK, 'USD', 'LOCKED_IN_ESCROW');
	const amount = round2(escrow.amount);
	return isV2Escrow(escrow) ? { ...b, gross: amount, net: amount, note: 'لا رسوم على تمويل الضمان' } : unrecorded(b, amount);
}

export function failedDepositBreakdown(currency: string): Breakdown {
	return { ...base('DEPOSIT', 'محاولة إيداع عبر PayPal لم تكتمل', currency, 'ADDED_TO_WALLET'), net: 0, note: 'لم يُضف أي مبلغ إلى رصيدك' };
}

/** A v2 stage release: gross/commission/net as the cumulative split replay (same as the release itself) with the escrow's recorded rate + level. */
export function stageReleaseBreakdown(escrow: any, split: { gross: number; commission: number; net: number } | undefined, stage: { amount: number; title: string }): Breakdown {
	const b = { ...base('STAGE_RELEASE', 'إفراج دفعة مرحلة', 'USD', 'WITHDRAWABLE'), note: stage.title };
	if (isV2Escrow(escrow)) {
		if (!split || num(escrow.providerCommissionRateSnapshot) == null) return unrecorded(b, round2(stage.amount));
		return { ...b, gross: round2(split.gross), net: round2(split.net), deductions: [commissionDeduction(split.commission, escrow)] };
	}
	// legacy escrow: released gross by design, the provider has no deduction on it
	return { ...b, gross: round2(stage.amount), net: round2(stage.amount), note: `${stage.title} · عقد قديم بلا عمولة على مقدم الخدمة` };
}

export function legacyEscrowReleaseBreakdown(residual: number): Breakdown {
	return { ...base('ESCROW_RELEASE', 'إفراج ضمان المشروع', 'USD', 'WITHDRAWABLE'), gross: round2(residual), net: round2(residual), note: 'عقد قديم بلا عمولة على مقدم الخدمة' };
}

export function cancellationSettlementBreakdown(r: { settlementReleaseToProvider: number | null; settlementPlatformCommission: number | null; settlementProviderNet: number | null }, escrow: any): Breakdown {
	const b = base('CANCELLATION_SETTLEMENT', 'تسوية إلغاء بالتراضي', 'USD', 'WITHDRAWABLE');
	const gross = num(r.settlementReleaseToProvider); const commission = num(r.settlementPlatformCommission); const net = num(r.settlementProviderNet);
	if (gross == null || net == null) return unrecorded(b, net ?? gross);
	const commissionAmount = commission ?? round2(gross - net);
	return { ...b, gross: round2(gross), net: round2(net), deductions: commissionAmount > 0 ? [commissionDeduction(commissionAmount, escrow)] : [] };
}

export function escrowFundedBreakdown(price: number): Breakdown {
	return { ...base('ESCROW_FUNDED', 'تمويل ضمان المشروع', 'USD', 'HELD'), gross: round2(price), net: round2(price), note: 'مبلغ محجوز لصالحك حتى إفراج الدفعات' };
}

// ── marketer ──
export function commissionBreakdown(c: { amount: number; currency: string; type?: string; baseAmount?: number | null; appliedPercentage?: number | null; level?: number | null }): Breakdown {
	const b = base('COMMISSION', 'عمولة إحالة', c.currency, 'COMMISSION_EARNED');
	const amount = round2(c.amount);
	const baseAmount = num(c.baseAmount); const pct = num(c.appliedPercentage); const level = num(c.level);
	if (baseAmount == null || pct == null) return unrecorded(b, amount);
	// the platform bears the marketer commission: nothing is deducted from it
	return { ...b, gross: amount, net: amount, note: `${pct}% من ${round2(baseAmount)} (المبلغ المُفرَج)${level != null ? ` · المستوى ${level} وقت الاستحقاق` : ''} · المنصة تتحمل العمولة ولا يوجد خصم` };
}

// the same wording the marketer withdraw page shows for a withdrawal status
export const WITHDRAWAL_STATUS_AR: Record<string, string> = { PENDING: 'بانتظار مراجعة الإدارة', APPROVED: 'معتمد', PROCESSING: 'قيد التحويل', COMPLETED: 'مدفوع', REJECTED: 'مرفوض', REVERSED: 'أُعيد من PayPal' };

export function withdrawalBreakdown(w: { amount: number; currency: string; status: string }): Breakdown {
	return { ...base('WITHDRAWAL', 'طلب سحب', w.currency, 'DEBITED_FROM_WALLET'), gross: round2(w.amount), net: round2(w.amount), note: `الحالة: ${WITHDRAWAL_STATUS_AR[w.status] ?? 'غير معروفة'}` };
}

export const NOT_FOUND_TX = 'المعاملة غير موجودة أو لا تملك صلاحية الوصول إليها';

export const pageOf = <T>(rows: T[], rawPage: unknown, rawLimit: unknown) => {
	const page = Math.max(1, Math.floor(Number(rawPage)) || 1);
	const limit = Math.min(100, Math.max(1, Math.floor(Number(rawLimit)) || 20));
	return { items: rows.slice((page - 1) * limit, page * limit), pagination: { page, limit, total: rows.length, totalPages: Math.ceil(rows.length / limit) } };
};

export type Direction = 'IN' | 'OUT' | 'HOLD' | 'NONE';
/** Display convention for client rows: `amount` stays the STORED signed value; `displayAmount` is its absolute value and `direction` says which way the money moved. */
export function clientDirection(type: string, amount: number, status?: string): Direction {
	if (status === 'FAILED') return 'NONE';
	if (type === 'ESCROW_LOCK') return 'HOLD';
	if (type === 'DEPOSIT' || type === 'REFUND' || type === 'AMENDMENT_REFUND') return 'IN';
	if (type === 'WITHDRAWAL' || type === 'ORDER_PAYMENT' || type === 'AMENDMENT_TOPUP') return 'OUT';
	return amount < 0 ? 'OUT' : 'IN';
}
