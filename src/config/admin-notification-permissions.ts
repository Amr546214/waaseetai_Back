/**
 * Which permission a staff member must CURRENTLY hold to receive (and to still see, in the inbox) each admin notification. Recipients are chosen by this at send time, and the inbox
 * hides what the viewer no longer holds the permission for, so withdrawing a permission also withdraws what was already delivered.
 */
export const ADMIN_NOTIFY_EVENT_PERMISSION = {
	NEW_DISPUTE: 'disputes.view',
	NEW_TICKET: 'support.review',
	WITHDRAWAL_REQUESTED: 'withdrawals.review',
	KYC_SUBMITTED: 'identity.review',
	SUSPICIOUS_PAYMENT: 'finance.read',
	PAYOUT_FAILED: 'payouts.send',
} as const;
export type AdminNotifyEventKey = keyof typeof ADMIN_NOTIFY_EVENT_PERMISSION;
export const ADMIN_NOTIFY_TYPE_PREFIX = 'ADMIN_';
export const adminNotifyType = (event: AdminNotifyEventKey) => `${ADMIN_NOTIFY_TYPE_PREFIX}${event}`;
