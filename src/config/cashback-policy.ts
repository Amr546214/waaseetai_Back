/**
 * Client cashback = the approved workbook «نظام النقاط و الولاء.xlsx», sheet «الأرباح» (the XLSX is the ONLY reference for values, rates, formulas and conditions):
 *   K39  level rate                       (the client ladder of the sheet «المستويات»; level 13 = 4.6%, Levels!G47 and Earnings!D47)
 *   K40  base cashback = qualified volume x K39
 *   K41  rating factor  = average rating >= 4.8 -> 1.2, else >= 4 -> 1.0, else 0.8
 *   K42  payment factor = input K38 >= 80 -> 1.1, else 1.0        (a BRANCH of the payment coefficient, never an eligibility gate)
 *   K43  cashback       = K40 x K41 x K42
 * Nothing here is adjusted because it looks illogical; the formulas are implemented exactly as stated.
 *
 * Owner approval (2026-11-13): K38 is an audited score out of 100 per contract. No real client rating means a pending entitlement, never an invented rating.
 * Wallet credit is immediate once the project is completed by delivery and both inputs exist. Engine activation is explicit through CASHBACK_ENGINE_ENABLED=true and CASHBACK_WALLET_TIMING=IMMEDIATE.
 */
export type CashbackBlockReason = 'CASHBACK_ENGINE_DISABLED' | 'CASHBACK_WALLET_TIMING_UNDEFINED' | 'CASHBACK_PAYMENT_SPEED_INPUT_UNDEFINED' | 'CASHBACK_RATING_INPUT_MISSING';

/** recorded on every ledger row: where the formula comes from */
export const CASHBACK_FORMULA_CODE = 'XLSX_EARNINGS_K39_K43';
/** the ladder = the single client ladder of config/levels.config.ts, which equals the workbook's «المستويات» table (checked cell by cell, level 13 = 4.6%) */
export const CASHBACK_LADDER_SOURCE = 'xlsx:Levels(client)=levels.config:CLIENT_LEVELS';

export const CASHBACK_RATING_STEP_HIGH = 4.8;
export const CASHBACK_RATING_STEP_BASE = 4;
export const CASHBACK_PAYMENT_BRANCH_THRESHOLD = 80;

/** K41 */
export const cashbackRatingFactor = (avgRating: number): 1.2 | 1 | 0.8 => (avgRating >= CASHBACK_RATING_STEP_HIGH ? 1.2 : avgRating >= CASHBACK_RATING_STEP_BASE ? 1 : 0.8);
/** K42 (K38 = the payment input) */
export const cashbackPaymentFactor = (paymentInput: number): 1.1 | 1 => (paymentInput >= CASHBACK_PAYMENT_BRANCH_THRESHOLD ? 1.1 : 1);

const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;
/** K40 / K43, exactly as stated */
export function computeCashback(input: { qualifiedVolume: number; ratePercent: number; avgRating: number; paymentInput: number }) {
	const base = round2(input.qualifiedVolume * (input.ratePercent / 100)); // K40
	const ratingFactor = cashbackRatingFactor(input.avgRating); // K41
	const paymentFactor = cashbackPaymentFactor(input.paymentInput); // K42
	return { base, ratingFactor, paymentFactor, amount: round2(input.qualifiedVolume * (input.ratePercent / 100) * ratingFactor * paymentFactor) }; // K43
}

/** Owner-approved operational inputs (2026-11-13): manual, audited score /100 per contract; wait for real rating; immediate wallet credit. */
export const CASHBACK_OPEN_INPUTS: ReadonlyArray<{ code: CashbackBlockReason; question: string }> = [];

/** engine + wallet-timing gate (the two switches); the payment input and the rating input are checked where they are read */
export function cashbackGate(env: NodeJS.ProcessEnv = process.env): CashbackBlockReason | null {
	if (env.CASHBACK_ENGINE_ENABLED !== 'true') return 'CASHBACK_ENGINE_DISABLED';
	if (env.CASHBACK_WALLET_TIMING !== 'IMMEDIATE') return 'CASHBACK_WALLET_TIMING_UNDEFINED';
	return null;
}
