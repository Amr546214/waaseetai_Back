import { NotificationCategory } from '@prisma/client';
import { logger } from '../config/logger';
import { notificationService } from './notification.service';
import { adminRecipientsHolding } from './admin-access.service';
import { ADMIN_NOTIFY_EVENT_PERMISSION, adminNotifyType } from '../config/admin-notification-permissions';
import { sendAdminMailboxAlert } from './admin-mailbox-alert.service';

/**
 * In-app notifications for the staff who currently hold the permission for that kind of work (never every ADMIN / SUPER_ADMIN account). One inbox row per active admin goes through
 * notificationService.createAndEmit, so the admin's saved channels (real-time push / e-mail copy) apply like for everyone else.
 * notifyAdmins NEVER throws: callers fire it as `void notifyAdmins(...)` and a failure is only logged, so it can never fail the business action.
 *
 * Every actionUrl is a real route of the super-admin router (angular-app supper-admin.routes.ts, mounted at /supper-admin-overview).
 */
export const ADMIN_ROUTES = {
	dispute: (id: string) => `/supper-admin-overview/disputes/${id}`,
	ticket: (id: string) => `/supper-admin-overview/support/${id}`,
	withdrawal: (id: string) => `/supper-admin-overview/withdrawals/${id}`,
	kyc: '/supper-admin-overview/kyc',
	// Payments are reviewed from the risk centre (no per-payment admin page exists).
	risk: '/supper-admin-overview/risk-center'
} as const;

export type AdminNotifyEvent = 'NEW_DISPUTE' | 'NEW_TICKET' | 'WITHDRAWAL_REQUESTED' | 'KYC_SUBMITTED' | 'SUSPICIOUS_PAYMENT' | 'PAYOUT_FAILED';

export interface AdminNotifyPayload {
	/** Id of the dispute / ticket / withdrawal the link opens. */
	id?: string;
	/** A short human reference (ticket number, request title, ...) shown in the message. */
	ref?: string | null;
	/** Anything else worth keeping with the row (never secrets). */
	metadata?: Record<string, unknown>;
}

const withRef = (text: string, ref?: string | null) => (ref ? `${text} (${String(ref).slice(0, 80)})` : text);

const buildCopy = (event: AdminNotifyEvent, p: AdminNotifyPayload): { title: string; message: string; category: NotificationCategory; actionUrl: string; actionText: string } | null => {
	switch (event) {
		case 'NEW_DISPUTE':
			return { title: 'نزاع جديد', message: withRef('تم فتح نزاع جديد ويحتاج إلى مراجعة', p.ref), category: NotificationCategory.PROJECTS, actionUrl: p.id ? ADMIN_ROUTES.dispute(p.id) : '/supper-admin-overview/disputes', actionText: 'فتح النزاع' };
		case 'NEW_TICKET':
			return { title: 'تذكرة دعم جديدة', message: withRef('وصلت تذكرة دعم جديدة', p.ref), category: NotificationCategory.ALL, actionUrl: p.id ? ADMIN_ROUTES.ticket(p.id) : '/supper-admin-overview/support', actionText: 'فتح التذكرة' };
		case 'WITHDRAWAL_REQUESTED':
			return { title: 'طلب سحب جديد', message: withRef('تم تقديم طلب سحب ويحتاج إلى اعتماد', p.ref), category: NotificationCategory.FINANCIAL, actionUrl: p.id ? ADMIN_ROUTES.withdrawal(p.id) : '/supper-admin-overview/withdrawals', actionText: 'مراجعة الطلب' };
		case 'KYC_SUBMITTED':
			return { title: 'مستند هوية جديد', message: withRef('تم رفع مستند هوية جديد ويحتاج إلى مراجعة', p.ref), category: NotificationCategory.ALL, actionUrl: ADMIN_ROUTES.kyc, actionText: 'مراجعة الهوية' };
		case 'SUSPICIOUS_PAYMENT':
			return { title: 'عملية دفع مشبوهة', message: withRef('رُفضت عملية دفع لعدم تطابق بياناتها مع الطلب المسجل، يرجى المراجعة', p.ref), category: NotificationCategory.FINANCIAL, actionUrl: ADMIN_ROUTES.risk, actionText: 'مركز المخاطر' };
		case 'PAYOUT_FAILED':
			return { title: 'فشل تحويل سحب', message: withRef('فشل تحويل مبلغ السحب عبر PayPal وأُعيد الطلب إلى حالة معتمد', p.ref), category: NotificationCategory.FINANCIAL, actionUrl: p.id ? ADMIN_ROUTES.withdrawal(p.id) : '/supper-admin-overview/withdrawals', actionText: 'مراجعة الطلب' };
		default:
			return null;
	}
};

export async function notifyAdmins(event: AdminNotifyEvent, payload: AdminNotifyPayload = {}): Promise<void> {
	try {
		const copy = buildCopy(event, payload);
		if (!copy) return;
		// the institutional mailbox (setting `adminNotificationEmail`) is a separate channel from the permission-based staff inbox below; it never reads or changes who the staff recipients are
		void sendAdminMailboxAlert(event, copy.actionUrl, payload.id);
		const admins = (await adminRecipientsHolding(ADMIN_NOTIFY_EVENT_PERMISSION[event])).map(id => ({ id }));
		const results = await Promise.allSettled(admins.map(admin => notificationService.createAndEmit({
			userId: admin.id, title: copy.title, message: copy.message, category: copy.category, type: adminNotifyType(event),
			actionUrl: copy.actionUrl, actionText: copy.actionText, metadata: { event, ...(payload.id ? { id: payload.id } : {}), ...(payload.metadata ?? {}) }
		})));
		const failed = results.filter(r => r.status === 'rejected').length;
		if (failed) logger.error(`[AdminNotifications] ${event}: ${failed}/${admins.length} notifications failed`);
	} catch (error) {
		logger.error(`[AdminNotifications] ${event} failed: ${(error as Error)?.message ?? error}`);
	}
}
