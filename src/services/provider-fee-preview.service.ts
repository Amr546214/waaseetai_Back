import { prisma } from '../config/db';
import { feePolicyService } from './fee-policy.service';
import { levelDef, MIN_LEVEL } from '../config/levels.config';
import { LEGACY_CURRENCY, requireCurrency, roundMoney } from '../utils/currency';
import { commissionOn } from '../utils/escrow-commission';
import { AppError } from '../utils/app-error';

/**
 * What the provider will get out of a price BEFORE anyone signs or funds: the platform commission and the net, from the provider's current level and the fee policy in force now.
 * It is an ESTIMATE of terms that are fixed later: the rate is frozen on the escrow when the client signs and funds the contract (policy in force THEN, the provider's level THEN), so the
 * answer says so explicitly instead of letting the first sight of the commission be the money arriving.
 */
export const providerFeePreviewService = {
	async preview(providerId: string, rawPrice: unknown, rawCurrency: unknown) {
		const price = Number(rawPrice);
		if (!Number.isFinite(price) || price <= 0 || price > 1_000_000_000) throw new AppError('السعر غير صالح', 400);
		const currency = rawCurrency == null || rawCurrency === '' ? LEGACY_CURRENCY : requireCurrency(rawCurrency);
		const [policy, gamification] = await Promise.all([feePolicyService.active(), prisma.providerGamification.findUnique({ where: { providerId }, select: { currentLevelIndex: true } })]);
		const level = levelDef('PROVIDER', Number.isInteger(gamification?.currentLevelIndex) ? (gamification!.currentLevelIndex as number) : MIN_LEVEL).level;
		const ratePercent = policy.payload.providerCommissionByLevel[level - 1];
		const commission = commissionOn(price, ratePercent);
		return {
			currency, price: roundMoney(price, currency), level, ratePercent, commission, net: roundMoney(price - commission, currency),
			policy: { version: policy.version, effectiveFrom: policy.effectiveFrom },
			isEstimate: true,
			lockedAt: 'ESCROW_FUNDING' as const,
			note: 'تقدير بحسب مستواك الحالي وسياسة الرسوم السارية الآن. تُثبَّت النسبة نهائيًا لهذا العقد عندما يوقّع العميل ويموّل الضمان، بحسب مستواك والسياسة السارية وقتها.',
		};
	},
};
