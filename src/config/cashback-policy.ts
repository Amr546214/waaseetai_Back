/**
 * Client cashback policy gate. The OWNER-STATED parts are implemented (rate ladder by client level, accrual on the value actually paid and released by delivery, wallet credit, ledger).
 * Three parts of the references are NOT unambiguous and are therefore BLOCKED behind one specific reason code until the owner approves ONE option (nothing is guessed):
 *   1. the coefficients: the explanation speaks of quality / speed, the workbook (الأرباح K39:K43) uses a rating factor and a payment factor, with a label «ساعة / عكسية» and a >=80 condition;
 *   2. the >=80 condition itself (what is measured, and what happens below it);
 *   3. when the money reaches the wallet (at accrual vs after a grace period stated in the PDF).
 * `CASHBACK_ENGINE_ENABLED=true` AND `CASHBACK_APPROVED_POLICY=BASE_RATE_IMMEDIATE` is the explicit approval of: factors fixed at 1.0, no >=80 gate, credit in the accrual transaction.
 * Without both, no cashback is accrued and the caller receives the reason code. The default is OFF.
 */
export type CashbackBlockReason = 'CASHBACK_ENGINE_DISABLED' | 'CASHBACK_POLICY_UNAPPROVED';
export interface CashbackPolicy { code: 'BASE_RATE_IMMEDIATE'; ratingFactor: 1; paymentFactor: 1 }

/** the ladder source recorded on every ledger row (the single client ladder of config/levels.config.ts; the rates match P-SK-038 and the workbook except level 13, see CASHBACK_LADDER_DISCREPANCY) */
export const CASHBACK_LADDER_SOURCE = 'levels.config:CLIENT_LEVELS@2026-10';
/** the workbook's cashback table lists level 13 (مؤسس) as 5% while the owner-confirmed ladder (and this code) uses 4.6%: reported, not resolved here */
export const CASHBACK_LADDER_DISCREPANCY = { level: 13, ladder: 4.6, workbook: 5 } as const;

export const CASHBACK_OPEN_DECISIONS: ReadonlyArray<{ code: string; question: string; options: string[] }> = [
	{ code: 'COEFFICIENTS', question: 'ما معاملات الكاش باك؟ (الجودة/السرعة في الشرح مقابل معامل التقييم ومعامل السداد في XLSX)', options: ['معاملات = 1 (النسبة الأساسية فقط)', 'معامل تقييم 1.2/1.0/0.8 (cashbackRatingFactor الموجودة غير مفعّلة) + معامل سداد غير معرّف', 'اعتماد معادلة جديدة بقيم صريحة'] },
	{ code: 'QUALITY_GATE_80', question: 'ما شرط >=80 وما المقيس به وما الأثر دونه؟', options: ['لا شرط', 'درجة تقييم المشروع >= 80', 'درجة سرعة السداد >= 80'] },
	{ code: 'WALLET_TIMING', question: 'متى يدخل الكاش باك المحفظة؟', options: ['فور اكتمال المشروع', 'بعد مهلة (أيام) تُحدَّد من المستند'] }
];

export function activeCashbackPolicy(env: NodeJS.ProcessEnv = process.env): { policy: CashbackPolicy } | { blocked: CashbackBlockReason } {
	if (env.CASHBACK_ENGINE_ENABLED !== 'true') return { blocked: 'CASHBACK_ENGINE_DISABLED' };
	if (env.CASHBACK_APPROVED_POLICY !== 'BASE_RATE_IMMEDIATE') return { blocked: 'CASHBACK_POLICY_UNAPPROVED' };
	return { policy: { code: 'BASE_RATE_IMMEDIATE', ratingFactor: 1, paymentFactor: 1 } };
}
