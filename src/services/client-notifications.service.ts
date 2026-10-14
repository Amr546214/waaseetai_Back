import { NotificationCategory, Prisma } from '@prisma/client';
import { logger } from '../config/logger';
import { notificationService } from './notification.service';

/**
 * The client-facing notifications, one builder per event (a pure function that returns the notification's type, title, message and destination), so the
 * wording and the destination of an event live in ONE place whichever service raises it. The inbox row is always stored; the client's saved channels
 * (notification_preferences: in-app / e-mail / topic toggles, and client_profiles.interfaceLanguage) apply at delivery (see NotificationService.deliver).
 *
 * Every actionUrl is a real route of the client router (angular-app client.routes.ts mounted at /client-overview); CLIENT_ROUTES is the one place they are written.
 */
export const CLIENT_ROUTES = {
	// The request page lists the offers received on it and carries the negotiation thread.
	request: (requestId: string) => `/client-overview/my-requests/${requestId}`,
	project: (projectId: string) => `/client-overview/projects/${projectId}`,
	deliveryReview: (projectId: string, stageId: string) => `/client-overview/projects/${projectId}/delivery-review/${stageId}`,
	rating: (projectId: string) => `/client-overview/projects/${projectId}/rating`,
	activeProjects: '/client-overview/projects/active',
	amendments: '/client-overview/projects/amendments',
	disputes: '/client-overview/disputes',
	wallet: '/client-overview/finance/wallet',
	invoices: '/client-overview/finance/invoices',
	// The identity documents (KYC) are uploaded and followed from the profile page.
	profile: '/client-overview/profile'
} as const;

export type ClientNotificationInput = {
	userId: string; title: string; message: string; type: string; category: NotificationCategory;
	actionUrl: string; actionText: string; metadata?: Prisma.InputJsonObject;
};

const short = (text: string | null | undefined, max = 60) => {
	const t = (text ?? '').trim();
	return t.length > max ? `${t.slice(0, max)}…` : t;
};
const quoted = (text: string | null | undefined) => (short(text) ? ` «${short(text)}»` : '');
const usd = (n: number) => `${Math.round(n * 100) / 100} $`;

const PROJECTS = NotificationCategory.PROJECTS;
const OFFERS = NotificationCategory.OFFERS;
const FINANCIAL = NotificationCategory.FINANCIAL;

/** Pure builders: the same object is stored by createAndEmit or, inside a transaction, by tx.notification.create({ data }). */
export const clientNotificationFor = {
	offerReceived: (p: { clientId: string; requestId: string; offerId: string; requestTitle?: string | null; providerName: string }): ClientNotificationInput => ({
		userId: p.clientId, title: 'تم استلام عرض جديد', message: `تم استلام عرض جديد على مشروعك${quoted(p.requestTitle)} من ${p.providerName}.`,
		type: 'NEW_PROPOSAL', category: OFFERS, actionUrl: CLIENT_ROUTES.request(p.requestId), actionText: 'عرض العروض', metadata: { requestId: p.requestId, offerId: p.offerId }
	}),
	offerWithdrawn: (p: { clientId: string; requestId: string; offerId: string; requestTitle?: string | null }): ClientNotificationInput => ({
		userId: p.clientId, title: 'تم سحب عرض على مشروعك', message: `سحب مقدم الخدمة عرضه على مشروعك${quoted(p.requestTitle)}.`,
		type: 'OFFER_WITHDRAWN', category: OFFERS, actionUrl: CLIENT_ROUTES.request(p.requestId), actionText: 'عرض الطلب', metadata: { projectId: p.requestId, offerId: p.offerId }
	}),
	offerCounter: (p: { clientId: string; requestId: string; offerId: string; messageId: string; requestTitle?: string | null; price: number; deliveryDays: number }): ClientNotificationInput => ({
		userId: p.clientId, title: 'عرض مضاد على مشروعك', message: `أرسل مقدم الخدمة عرضًا مضادًا على${quoted(p.requestTitle)}: ${usd(p.price)} خلال ${p.deliveryDays} يومًا.`,
		type: 'OFFER_COUNTER', category: OFFERS, actionUrl: CLIENT_ROUTES.request(p.requestId), actionText: 'مراجعة العرض المضاد', metadata: { projectId: p.requestId, offerId: p.offerId, messageId: p.messageId }
	}),
	negotiationDeclined: (p: { clientId: string; requestId: string; offerId: string; messageId: string; requestTitle?: string | null }): ClientNotificationInput => ({
		userId: p.clientId, title: 'ردّ مقدم الخدمة على طلب التفاوض', message: `اعتذر مقدم الخدمة عن طلب التفاوض على${quoted(p.requestTitle)}، ويبقى عرضه بشروطه الأصلية.`,
		type: 'OFFER_NEGOTIATION_REJECTED', category: OFFERS, actionUrl: CLIENT_ROUTES.request(p.requestId), actionText: 'عرض الطلب', metadata: { projectId: p.requestId, offerId: p.offerId, messageId: p.messageId }
	}),
	amendmentRequested: (p: { clientId: string; projectId: string; amendmentId: string; title: string }): ClientNotificationInput => ({
		userId: p.clientId, title: 'طلب تعديل جديد على مشروعك', message: `طلب مقدم الخدمة تعديلًا على المشروع: ${short(p.title)}`,
		type: 'PROJECT_AMENDMENT', category: PROJECTS, actionUrl: CLIENT_ROUTES.amendments, actionText: 'مراجعة الطلب', metadata: { projectId: p.projectId, amendmentId: p.amendmentId }
	}),
	amendmentAnswered: (p: { clientId: string; projectId: string; amendmentId: string; title: string; decision: 'approve' | 'reject' }): ClientNotificationInput => {
		const approved = p.decision === 'approve';
		return {
			userId: p.clientId, title: approved ? 'وافق مقدم الخدمة على طلب التعديل' : 'رفض مقدم الخدمة طلب التعديل',
			message: `${approved ? 'وافق' : 'رفض'} مقدم الخدمة على طلب التعديل «${short(p.title)}». القرار مسجّل فقط ولا يغيّر السعر أو المدة أو الضمان تلقائيًا.`,
			type: 'PROJECT_AMENDMENT', category: PROJECTS, actionUrl: CLIENT_ROUTES.amendments, actionText: 'عرض طلبات التعديل', metadata: { projectId: p.projectId, amendmentId: p.amendmentId, decision: p.decision }
		};
	},
	stageDelivered: (p: { clientId: string; projectId: string; stageId: string; stageTitle: string; deliveryId?: string }): ClientNotificationInput => ({
		userId: p.clientId, title: 'تسليم جديد بانتظار مراجعتك', message: `تم تسليم مرحلة: ${short(p.stageTitle)}`,
		type: 'STAGE_DELIVERY', category: PROJECTS, actionUrl: CLIENT_ROUTES.deliveryReview(p.projectId, p.stageId), actionText: 'مراجعة التسليم',
		metadata: { projectId: p.projectId, stageId: p.stageId, ...(p.deliveryId ? { deliveryId: p.deliveryId } : {}) }
	}),
	stageApproved: (p: { clientId: string; projectId: string; stageId: string; stageTitle: string; amount: number }): ClientNotificationInput => ({
		userId: p.clientId, title: 'تم اعتماد المرحلة', message: `اعتمدت مرحلة «${short(p.stageTitle)}» وأُفرج ${usd(p.amount)} من الضمان لمقدم الخدمة.`,
		type: 'STAGE_APPROVED', category: PROJECTS, actionUrl: CLIENT_ROUTES.project(p.projectId), actionText: 'عرض المشروع', metadata: { projectId: p.projectId, stageId: p.stageId, amount: p.amount }
	}),
	projectCompleted: (p: { clientId: string; projectId: string; projectTitle?: string | null }): ClientNotificationInput => ({
		userId: p.clientId, title: 'اكتمل مشروعك', message: `اعتمدت التسليم النهائي لمشروعك${quoted(p.projectTitle)} وأُغلق العقد. يمكنك الآن تقييم مقدم الخدمة.`,
		type: 'PROJECT_COMPLETED', category: PROJECTS, actionUrl: CLIENT_ROUTES.rating(p.projectId), actionText: 'تقييم مقدم الخدمة', metadata: { projectId: p.projectId }
	}),
	disputeOpened: (p: { clientId: string; disputeId: string; openedBy: 'client' | 'provider'; requestTitle?: string | null }): ClientNotificationInput => ({
		userId: p.clientId,
		title: p.openedBy === 'client' ? 'تم تسجيل نزاعك' : 'تم فتح نزاع على مشروعك',
		message: p.openedBy === 'client' ? `تم فتح النزاع${quoted(p.requestTitle)} وهو بانتظار مراجعة الإدارة.` : `فتح مقدم الخدمة نزاعًا${quoted(p.requestTitle)}. يمكنك متابعة حالته من صفحة النزاعات.`,
		type: 'DISPUTE_OPENED', category: PROJECTS, actionUrl: CLIENT_ROUTES.disputes, actionText: 'عرض النزاعات', metadata: { disputeId: p.disputeId, openedBy: p.openedBy }
	}),
	disputeResolved: (p: { clientId: string; disputeId: string; action: 'resolve' | 'reject'; resolution?: string | null }): ClientNotificationInput => {
		const resolved = p.action === 'resolve';
		const decision = short(p.resolution, 120);
		return {
			userId: p.clientId, title: resolved ? 'تم حسم النزاع' : 'تم إغلاق النزاع دون قبوله',
			message: `${resolved ? 'أنهت الإدارة مراجعة النزاع.' : 'رفضت الإدارة النزاع بعد مراجعته.'}${decision ? ` القرار: ${decision}` : ''}`,
			type: 'DISPUTE_RESOLVED', category: PROJECTS, actionUrl: CLIENT_ROUTES.disputes, actionText: 'عرض النزاعات', metadata: { disputeId: p.disputeId, action: p.action }
		};
	},
	escrowFunded: (p: { clientId: string; requestId: string; amount: number; projectName?: string | null }): ClientNotificationInput => ({
		userId: p.clientId, title: 'تم إيداع الضمان', message: `حُجز ${usd(p.amount)} من محفظتك في الضمان لمشروع${quoted(p.projectName)}. يبدأ التنفيذ عندما يوقّع مقدم الخدمة العقد.`,
		type: 'ESCROW_FUNDED', category: FINANCIAL, actionUrl: CLIENT_ROUTES.activeProjects, actionText: 'عرض مشاريعي', metadata: { requestId: p.requestId, amount: p.amount }
	}),
	orderPaid: (p: { clientId: string; orderId: string; orderNumber?: string | null; total: number; projectIds: string[] }): ClientNotificationInput => ({
		userId: p.clientId, title: 'تم دفع طلبك', message: `خُصم ${usd(p.total)} من محفظتك لطلب الخدمة${p.orderNumber ? ` رقم ${p.orderNumber}` : ''}، وبدأ المشروع.`,
		type: 'ORDER_PAID', category: FINANCIAL, actionUrl: p.projectIds.length === 1 ? CLIENT_ROUTES.project(p.projectIds[0]) : CLIENT_ROUTES.activeProjects, actionText: 'عرض المشروع',
		metadata: { orderId: p.orderId, projectIds: p.projectIds }
	}),
	kycDecided: (p: { clientId: string; decision: 'APPROVED' | 'REJECTED'; reason?: string | null }): ClientNotificationInput => ({
		userId: p.clientId,
		title: p.decision === 'APPROVED' ? 'تم اعتماد توثيق هويتك' : 'تم رفض توثيق هويتك',
		message: p.decision === 'APPROVED' ? 'اعتمدت الإدارة مستندات هويتك وأصبح حسابك موثّقًا.' : `رفضت الإدارة مستندات الهوية.${p.reason ? ` السبب: ${short(p.reason, 200)}` : ''} يمكنك رفع مستند جديد وإعادة الإرسال.`,
		type: p.decision === 'APPROVED' ? 'KYC_APPROVED' : 'KYC_REJECTED', category: PROJECTS, actionUrl: CLIENT_ROUTES.profile, actionText: p.decision === 'APPROVED' ? 'عرض ملفي' : 'رفع مستند جديد', metadata: { decision: p.decision }
	}),
	depositCompleted: (p: { clientId: string; transactionId: string; credited: number; paid: number; fee: number }): ClientNotificationInput => ({
		userId: p.clientId, title: 'تم إيداع الرصيد بنجاح',
		message: `أُضيف مبلغ ${p.credited.toFixed(2)} دولار إلى رصيد محفظتك عبر PayPal${p.fee ? ` (المدفوع ${p.paid.toFixed(2)} شاملًا رسوم PayPal ${p.fee.toFixed(2)})` : ''}، يمكنك الآن استخدامه لتمويل المشاريع.`,
		type: 'FINANCIAL', category: FINANCIAL, actionUrl: CLIENT_ROUTES.wallet, actionText: 'عرض المحفظة', metadata: { transactionId: p.transactionId }
	})
};

const safely = async (label: string, send: () => Promise<unknown>) => {
	try { await send(); } catch (error) { logger.error(`[ClientNotifications] ${label} failed: ${(error as Error)?.message ?? error}`); }
};

/** Sends (stores + delivers) a client notification; a notification failure never fails the business action that triggered it. */
export const clientNotifications = {
	async send(input: ClientNotificationInput | null | undefined) {
		if (!input) return;
		await safely(input.type, () => notificationService.createAndEmit(input));
	},

	/** Stored client notifications that were created inside another write (tx.notification.create): deliver them through the client's channels. */
	async deliverStored(ids: Array<string | null | undefined>) {
		for (const id of ids) if (id) await safely('deliverStored', () => notificationService.emitStored(id));
	}
};
