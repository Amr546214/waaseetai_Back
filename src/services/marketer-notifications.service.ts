import { NotificationCategory } from '@prisma/client';
import { prisma } from '../config/db';
import { logger } from '../config/logger';
import { notificationService } from './notification.service';
import { formatMoney } from '../utils/currency';

/**
 * The marketer-facing notifications (referral joined, commission approved, withdrawal states, PayPal email change). Every one goes through
 * notificationService.createAndEmit: the inbox row is ALWAYS stored, and the marketer's saved switches (in-app / e-mail, per-event, language) decide
 * push and e-mail. A notification failure never fails the business action that triggered it.
 *
 * Every actionUrl is a real route of the marketer router (angular-app marketer.routes.ts, mounted at /marketer-overview); MARKETER_ROUTES is the one
 * place they are written. Events with no real source are NOT sent: there is no commission rejection (CommissionStatus is PENDING / APPROVED / PAID)
 * and no campaign entity, and a notification per click would flood the inbox (clicks are counted in the channel report instead).
 */
export const MARKETER_ROUTES = {
	referrals: '/marketer-overview/referrals',
	commissions: '/marketer-overview/commissions',
	withdraw: '/marketer-overview/withdraw',
	// The PayPal payout email is edited from the "بريد PayPal" tab of the marketer profile data page.
	paypalSettings: '/marketer-overview/profile/data',
	ticket: (ticketId: string) => `/marketer-overview/help/tickets/${ticketId}`
} as const;

const short = (text: string | null | undefined, max = 60) => {
	const t = (text ?? '').trim();
	return t.length > max ? `${t.slice(0, max)}…` : t;
};

const safely = async (label: string, send: () => Promise<unknown>) => {
	try { await send(); } catch (error) { logger.error(`[MarketerNotifications] ${label} failed: ${(error as Error)?.message ?? error}`); }
};

export type MarketerWithdrawalEvent = 'REQUESTED' | 'APPROVED' | 'REJECTED' | 'PAID' | 'FAILED' | 'REVERSED';

const isProviderUser = (user: { accountType: string; roles: string[] | null; activeRole: string | null }) =>
	user.accountType === 'PROVIDER_INDIVIDUAL' || user.accountType === 'PROVIDER_COMPANY' || (user.roles ?? []).includes('PROVIDER') || user.activeRole === 'PROVIDER';

export interface MarketerCommissionNotice { affiliateUserId: string; commissionId: string; amount: number; currency: string }

export const marketerNotifications = {
	/** The marketer's withdrawal changed state. Provider-earnings withdrawals are not marketer notifications and are skipped. */
	async withdrawal(withdrawalId: string, event: MarketerWithdrawalEvent) {
		await safely(`withdrawal ${event}`, async () => {
			const w = await prisma.withdrawal.findUnique({ where: { id: withdrawalId }, select: { id: true, userId: true, amount: true, currency: true, rejectionReason: true } });
			if (!w) return;
			const owner = await prisma.user.findUnique({ where: { id: w.userId }, select: { accountType: true, roles: true, activeRole: true, affiliateProfile: { select: { id: true } } } });
			if (!owner || !owner.affiliateProfile || isProviderUser(owner)) return;
			const amount = formatMoney(w.amount, w.currency);
			const copy: Record<MarketerWithdrawalEvent, { title: string; message: string }> = {
				REQUESTED: { title: 'تم استلام طلب السحب', message: `طلب سحب ${amount} قيد مراجعة الإدارة.` },
				APPROVED: { title: 'تم اعتماد طلب السحب', message: `اعتمدت الإدارة طلب سحب ${amount}.` },
				REJECTED: { title: 'تم رفض طلب السحب', message: `رُفض طلب سحب ${amount}.${w.rejectionReason ? ` السبب: ${short(w.rejectionReason, 200)}` : ''} المبلغ عاد إلى رصيدك القابل للسحب.` },
				PAID: { title: 'تم تحويل مبلغ السحب', message: `تم تحويل ${amount} إلى حساب PayPal الخاص بك.` },
				FAILED: { title: 'تعذّر تحويل مبلغ السحب', message: `تعذّر إتمام تحويل ${amount} عبر PayPal ولم يُخصم أي مبلغ. طلب السحب ما زال معتمدًا.` },
				REVERSED: { title: 'أُعيد مبلغ السحب من PayPal', message: `أبلغت PayPal باسترجاع تحويل ${amount} بعد إتمامه. تواصل مع الدعم لمعرفة التفاصيل.` }
			};
			await notificationService.createAndEmit({ userId: w.userId, ...copy[event], category: NotificationCategory.FINANCIAL, type: `WITHDRAWAL_${event}`, actionUrl: MARKETER_ROUTES.withdraw, actionText: 'عرض طلبات السحب', metadata: { withdrawalId: w.id, status: event } });
		});
	},

	/** The payout email was changed from the profile page. */
	async paypalEmailChanged(userId: string, removed: boolean) {
		await safely('paypalEmailChanged', () => notificationService.createAndEmit({
			userId,
			title: removed ? 'تمت إزالة بريد PayPal' : 'تم حفظ بريد PayPal جديد',
			message: removed ? 'أُزيل بريد PayPal المحفوظ، ولن تتمكن من طلب سحب حتى تضيف بريدًا جديدًا. إن لم تكن أنت، تواصل مع الدعم فورًا.' : 'تم حفظ بريد PayPal جديد لاستلام أرباحك. إن لم تكن أنت، تواصل مع الدعم فورًا.',
			category: NotificationCategory.FINANCIAL,
			type: 'PAYPAL_EMAIL_CHANGED',
			actionUrl: MARKETER_ROUTES.paypalSettings,
			actionText: 'مراجعة بريد PayPal'
		}));
	},

	/** A person registered through the marketer's referral link (the conversion of a click into a sign-up). Skipped when the marketer turned "إشعار عند إحالة جديدة" off in the referral-links settings. */
	async referralJoined(p: { affiliateId: string; referralId: string; referredName?: string | null }) {
		await safely('referralJoined', async () => {
			const affiliate = await prisma.affiliateProfile.findUnique({ where: { id: p.affiliateId }, select: { userId: true, notifyOnNewReferral: true } });
			if (!affiliate || affiliate.notifyOnNewReferral === false) return;
			const who = short(p.referredName, 40);
			await notificationService.createAndEmit({
				userId: affiliate.userId,
				title: 'إحالة جديدة',
				message: `${who ? `سجّل ${who}` : 'سجّل مستخدم جديد'} عبر رابط الإحالة الخاص بك.`,
				category: NotificationCategory.ALL,
				type: 'REFERRAL_JOINED',
				actionUrl: MARKETER_ROUTES.referrals,
				actionText: 'عرض الإحالات',
				metadata: { referralId: p.referralId }
			});
		});
	},

	/** Commissions that were just APPROVED (available for withdrawal). Called after the transaction that created them has committed. */
	async commissionsApproved(notices: MarketerCommissionNotice[]) {
		for (const n of notices) {
			await safely('commissionApproved', () => notificationService.createAndEmit({
				userId: n.affiliateUserId,
				title: 'عمولة جديدة',
				message: `أُضيفت عمولة ${formatMoney(n.amount, n.currency)} إلى رصيدك القابل للسحب.`,
				category: NotificationCategory.FINANCIAL,
				type: 'COMMISSION_APPROVED',
				actionUrl: MARKETER_ROUTES.commissions,
				actionText: 'عرض العمولات',
				metadata: { commissionId: n.commissionId, amount: n.amount, currency: n.currency }
			}));
		}
	}
};
