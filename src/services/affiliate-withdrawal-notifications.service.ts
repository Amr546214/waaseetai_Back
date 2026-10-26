import { NotificationCategory } from '@prisma/client';
import { prisma } from '../config/db';
import { logger } from '../config/logger';
import { notificationService } from './notification.service';
import type { ProviderWithdrawalEvent } from './provider-notifications.service';
import { formatMoney } from '../utils/currency';

/**
 * The marketer (affiliate) side of a withdrawal notification: the provider helper deliberately skips commission withdrawals, so a marketer used to
 * hear nothing when the admin approved / rejected / paid theirs. Same events, marketer wording, and the marketer router's own destination
 * (angular-app marketer.routes.ts `withdraw`). A failure here never fails the business action.
 */
export const AFFILIATE_ROUTES = { withdraw: '/marketer-overview/withdraw' } as const;

export const affiliateWithdrawalNotifications = {
	async withdrawal(withdrawalId: string, event: ProviderWithdrawalEvent) {
		try {
			const w = await prisma.withdrawal.findUnique({ where: { id: withdrawalId }, select: { id: true, userId: true, amount: true, currency: true, rejectionReason: true } });
			if (!w) return;
			const amount = formatMoney(w.amount, w.currency);
			const reason = w.rejectionReason ? ` السبب: ${w.rejectionReason.slice(0, 200)}` : '';
			const copy: Record<ProviderWithdrawalEvent, { title: string; message: string }> = {
				REQUESTED: { title: 'تم استلام طلب سحب العمولات', message: `طلب سحب ${amount} قيد مراجعة الإدارة.` },
				APPROVED: { title: 'تم اعتماد طلب سحب العمولات', message: `اعتمدت الإدارة طلب سحب ${amount}.` },
				REJECTED: { title: 'تم رفض طلب سحب العمولات', message: `رُفض طلب سحب ${amount}.${reason}` },
				PAID: { title: 'تم تحويل مبلغ السحب', message: `تم تحويل ${amount} إلى حساب PayPal الخاص بك.` },
				FAILED: { title: 'تعذّر تحويل مبلغ السحب', message: `تعذّر إتمام تحويل ${amount} عبر PayPal ولم يُخصم أي مبلغ. طلب السحب ما زال معتمدًا.` },
				REVERSED: { title: 'أُعيد مبلغ السحب من PayPal', message: `أبلغت PayPal باسترجاع تحويل ${amount} بعد إتمامه. تواصل مع الدعم لمعرفة التفاصيل.` }
			};
			await notificationService.createAndEmit({ userId: w.userId, ...copy[event], category: NotificationCategory.FINANCIAL, type: `WITHDRAWAL_${event}`, actionUrl: AFFILIATE_ROUTES.withdraw, actionText: 'عرض طلبات السحب', metadata: { withdrawalId: w.id, status: event } });
		} catch (error) {
			logger.error(`[AffiliateWithdrawalNotifications] ${event} failed: ${(error as Error)?.message ?? error}`);
		}
	}
};
