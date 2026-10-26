import { z } from 'zod';
import { PROVIDER_LEVELS, CLIENT_LEVELS, MARKETER_LEVELS } from './levels.config';
import { DEPOSIT_FEE_PERCENT, MARKETER_WITHDRAWAL_FEE_PERCENT } from '../utils/fee-policy';

/**
 * The shape and the LIMITS of a fee policy. The VALUES live in the database (fee_policy_versions); code only enforces what a policy may look like:
 * every percent is within a safe range, a higher level is never worse than a lower one (provider commission never rises with the level; cashback and marketer commission never fall),
 * minimum payouts are bounded. A baseline policy built from today's constants seeds version 1 and is the fallback when the store cannot be read.
 */
export const LEVEL_COUNT = 15;
export const FEE_LIMITS = { providerCommission: { min: 0.5, max: 25 }, clientCashback: { min: 0, max: 10 }, marketerCommission: { min: 0, max: 15 }, depositFee: { min: 0, max: 20 }, withdrawalFee: { min: 0, max: 20 }, minPayout: { min: 0, max: 10000 }, maxStepPercent: 3 } as const;
export const DEPOSIT_METHODS = ['mada', 'visa_mastercard', 'paypal', 'international_transfer', 'other'] as const;
export const WITHDRAWAL_METHODS = ['bank_transfer', 'paypal', 'usdt'] as const;

const pct = (min: number, max: number, what: string) => z.number({ message: `${what}: رقم مطلوب` }).finite().min(min, `${what}: لا يقل عن ${min}%`).max(max, `${what}: لا يزيد عن ${max}%`).refine(v => Math.abs(v * 100 - Math.round(v * 100)) < 1e-6, `${what}: خانتان عشريتان كحد أقصى`);
const ladder = (min: number, max: number, what: string, dir: 'down' | 'up') => z.array(pct(min, max, what)).length(LEVEL_COUNT, `${what}: ${LEVEL_COUNT} مستوى بالضبط`).refine(a => a.every((v, i) => i === 0 || (dir === 'down' ? v <= a[i - 1] : v >= a[i - 1])), dir === 'down' ? `${what}: لا ترتفع النسبة مع ارتفاع المستوى` : `${what}: لا تنخفض النسبة مع ارتفاع المستوى`);
const table = <K extends readonly string[]>(keys: K, min: number, max: number, what: string) => z.object(Object.fromEntries(keys.map(k => [k, pct(min, max, `${what} (${k})`)])) as Record<K[number], z.ZodNumber>).strict();

export const feePolicyPayloadSchema = z.object({
	providerCommissionByLevel: ladder(FEE_LIMITS.providerCommission.min, FEE_LIMITS.providerCommission.max, 'عمولة مقدم الخدمة', 'down'),
	clientCashbackByLevel: ladder(FEE_LIMITS.clientCashback.min, FEE_LIMITS.clientCashback.max, 'كاش باك طالب الخدمة', 'up'),
	marketerCommissionByLevel: ladder(FEE_LIMITS.marketerCommission.min, FEE_LIMITS.marketerCommission.max, 'عمولة الوسيط', 'up'),
	depositFeePercent: table(DEPOSIT_METHODS, FEE_LIMITS.depositFee.min, FEE_LIMITS.depositFee.max, 'رسوم الإيداع'),
	marketerWithdrawalFeePercent: table(WITHDRAWAL_METHODS, FEE_LIMITS.withdrawalFee.min, FEE_LIMITS.withdrawalFee.max, 'رسوم سحب الوسيط'),
	minMarketerPayout: z.number().finite().min(FEE_LIMITS.minPayout.min, 'الحد الأدنى لسحب الوسيط غير صالح').max(FEE_LIMITS.minPayout.max, 'الحد الأدنى لسحب الوسيط كبير جدًا').refine(v => Math.abs(v * 100 - Math.round(v * 100)) < 1e-6, 'الحد الأدنى لسحب الوسيط: خانتان عشريتان كحد أقصى'),
	minProviderPayout: z.number().finite().min(FEE_LIMITS.minPayout.min, 'الحد الأدنى لسحب مقدم الخدمة غير صالح').max(FEE_LIMITS.minPayout.max, 'الحد الأدنى لسحب مقدم الخدمة كبير جدًا').refine(v => Math.abs(v * 100 - Math.round(v * 100)) < 1e-6, 'الحد الأدنى لسحب مقدم الخدمة: خانتان عشريتان كحد أقصى'),
}).strict();
export type FeePolicyPayload = z.infer<typeof feePolicyPayloadSchema>;

/** The values in force before policies were managed: today's constants, copied, not changed. Version 1 (seeded by the migration) holds exactly this. */
export const baselineFeePolicyPayload = (): FeePolicyPayload => ({
	providerCommissionByLevel: PROVIDER_LEVELS.map(d => d.percent),
	clientCashbackByLevel: CLIENT_LEVELS.map(d => d.percent),
	marketerCommissionByLevel: MARKETER_LEVELS.map(d => d.percent),
	depositFeePercent: { ...DEPOSIT_FEE_PERCENT },
	marketerWithdrawalFeePercent: { ...MARKETER_WITHDRAWAL_FEE_PERCENT },
	minMarketerPayout: 300,
	minProviderPayout: 0,
});
export const BASELINE_FEE_POLICY_ID = '00000000-0000-4000-8000-000000000001';

/** which fields differ between two payloads, as `path: from -> to` (for the confirmation, the audit entry and the history) */
export function diffFeePolicy(a: FeePolicyPayload, b: FeePolicyPayload): Array<{ path: string; from: unknown; to: unknown }> {
	const out: Array<{ path: string; from: unknown; to: unknown }> = [];
	const walk = (x: unknown, y: unknown, path: string) => {
		if (Array.isArray(x) && Array.isArray(y)) x.forEach((v, i) => walk(v, y[i], `${path}[${i + 1}]`));
		else if (x && y && typeof x === 'object' && typeof y === 'object') for (const k of Object.keys(x as object)) walk((x as Record<string, unknown>)[k], (y as Record<string, unknown>)[k], path ? `${path}.${k}` : k);
		else if (x !== y) out.push({ path, from: x, to: y });
	};
	walk(a, b, ''); return out;
}
