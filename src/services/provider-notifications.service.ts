import { NotificationCategory } from '@prisma/client';
import { prisma } from '../config/db';
import { logger } from '../config/logger';
import { notificationService } from './notification.service';
import { resolutionLabelAr, type FinancialOutcomeSummary } from '../utils/dispute-resolution';
import { LEGACY_CURRENCY, formatMoney } from '../utils/currency';

/**
 * The provider-facing notifications for events that used to leave the provider with nothing (dispute, rating, withdrawal, PayPal email change,
 * amendment answer). Every one goes through notificationService.createAndEmit, so the inbox row is always stored and the provider's saved channels
 * (push / e-mail, e-mail language) apply. A notification failure never fails the business action that triggered it.
 *
 * Every actionUrl is a real route of the provider router (angular-app provider.routes.ts); PROVIDER_ROUTES is the one place they are written.
 */
export const PROVIDER_ROUTES = {
	dispute: (disputeId: string) => `/provider-overview/disputes/${disputeId}`,
	// Reviews received are shown on the provider's public profile.
	reviews: '/provider-overview/profile/public',
	// The provider's rating page of a project (project id or contract id); it reads the rating status first (form / saved card / blocked reason).
	rating: (projectId: string) => `/provider-overview/projects/${projectId}/rating`,
	// The offers list shows every offer with its live state (under negotiation, awaiting signature...).
	offers: '/provider-overview/offers',
	// Provider side of the offer negotiation; the id is the provider's own (canonical) offer id.
	offerNegotiate: (offerId: string) => `/provider-overview/offers/${offerId}/negotiate`,
	withdraw: '/provider-overview/finance/withdraw',
	// The PayPal payout email is edited from the "حساب PayPal" tab of the profile data page.
	paypalSettings: '/provider-overview/profile/data',
	// The progress page resolves its key as a project id or a contract id.
	projectProgress: (projectId: string) => `/provider-overview/projects/active/progress/${projectId}`,
	// The identity / KYC documents live in the profile data page.
	kyc: '/provider-overview/profile/data',
	// Specialties and their review state.
	specialties: '/provider-overview/profile/specialties',
	// The provider's own accreditation sample page (the id is the sample's).
	// Batch B T1: the request lives in the «إجراءات الحساب» log (the old accreditation-details page is not an approval status page).
	accreditation: (sampleId: string) => `/provider-overview/account-actions/${sampleId}`
} as const;

const short = (text: string | null | undefined, max = 60) => {
	const t = (text ?? '').trim();
	return t.length > max ? `${t.slice(0, max)}…` : t;
};

const safely = async (label: string, send: () => Promise<unknown>) => {
	try { await send(); } catch (error) { logger.error(`[ProviderNotifications] ${label} failed: ${(error as Error)?.message ?? error}`); }
};

const isProviderUser = (user: { accountType: string; roles: string[] | null; activeRole: string | null }) =>
	user.accountType === 'PROVIDER_INDIVIDUAL' || user.accountType === 'PROVIDER_COMPANY' || (user.roles ?? []).includes('PROVIDER') || user.activeRole === 'PROVIDER';

export type ProviderWithdrawalEvent = 'REQUESTED' | 'APPROVED' | 'REJECTED' | 'PAID' | 'FAILED' | 'REVERSED';

export const providerNotifications = {
	/** A dispute was opened on a provider's engagement: tell the provider it was opened against (client opened) or confirm it (provider opened). */
	async disputeOpened(p: { disputeId: string; providerId: string | null | undefined; openedBy: 'client' | 'provider'; requestTitle?: string | null }) {
		if (!p.providerId) return;
		const title = short(p.requestTitle);
		const forTitle = title ? ` على «${title}»` : '';
		await safely('disputeOpened', () => notificationService.createAndEmit(p.openedBy === 'client'
			? { userId: p.providerId!, title: 'تم فتح نزاع ضدك', message: `فتح العميل نزاعًا${forTitle}. يمكنك الاطلاع على التفاصيل ومتابعة حالته.`, category: NotificationCategory.PROJECTS, type: 'DISPUTE_OPENED', actionUrl: PROVIDER_ROUTES.dispute(p.disputeId), actionText: 'عرض النزاع', metadata: { disputeId: p.disputeId, openedBy: p.openedBy } }
			: { userId: p.providerId!, title: 'تم تسجيل نزاعك', message: `تم فتح النزاع${forTitle} وهو بانتظار مراجعة الإدارة.`, category: NotificationCategory.PROJECTS, type: 'DISPUTE_OPENED', actionUrl: PROVIDER_ROUTES.dispute(p.disputeId), actionText: 'عرض النزاع', metadata: { disputeId: p.disputeId, openedBy: p.openedBy } }));
	},

	/** An admin closed a dispute (resolved, or rejected as not upheld). */
	async disputeResolved(p: { disputeId: string; providerId: string | null | undefined; action: 'resolve' | 'reject'; resolution?: string | null; financial?: FinancialOutcomeSummary | null }) {
		if (!p.providerId) return;
		const resolved = p.action === 'resolve';
		const decision = short(resolutionLabelAr(p.resolution, !!p.financial), 120);
		const usd = (n: number) => formatMoney(n, p.financial?.currency ?? LEGACY_CURRENCY); // the settlement's own currency
		const money = p.financial
			? ` ${p.financial.releaseToProvider > 0 ? `صُرف لرصيدك ${usd(p.financial.providerNet)}${p.financial.platformCommission > 0 ? ` بعد خصم عمولة المنصة ${usd(p.financial.platformCommission)}` : ''}. ` : ''}${p.financial.refundToClient > 0 ? `أُعيد ${usd(p.financial.refundToClient)} إلى العميل من المبلغ المحتجز.` : ''}`.trimEnd()
			: ' لم يتغيّر أي مبلغ مالي بهذا القرار.';
		await safely('disputeResolved', () => notificationService.createAndEmit({
			userId: p.providerId!,
			title: resolved ? 'تم حسم النزاع' : 'تم إغلاق النزاع دون قبوله',
			message: `${resolved ? 'أنهت الإدارة مراجعة النزاع.' : 'رفضت الإدارة النزاع بعد مراجعته.'}${decision ? ` القرار: «${decision}».` : ''}${money}`,
			category: NotificationCategory.PROJECTS,
			type: 'DISPUTE_RESOLVED',
			actionUrl: PROVIDER_ROUTES.dispute(p.disputeId),
			actionText: 'عرض النزاع',
			metadata: { disputeId: p.disputeId, action: p.action }
		}));
	},

	/** A marketplace service was bought and its project started: the seller learns it the moment the payment committed. */
	async servicePurchased(p: { providerId: string | null | undefined; projectId: string; title?: string | null }) {
		if (!p.providerId) return;
		await safely('servicePurchased', () => notificationService.createAndEmit({
			userId: p.providerId!, title: 'طلب شراء جديد لخدمتك', message: `اشترى عميل خدمتك${p.title ? ` «${short(p.title)}»` : ''} وبدأ المشروع. افتح المشروع لمتابعة المراحل والتسليم.`,
			category: NotificationCategory.PROJECTS, type: 'SERVICE_PURCHASED', actionUrl: PROVIDER_ROUTES.projectProgress(p.projectId), actionText: 'عرض المشروع', metadata: { projectId: p.projectId }
		}));
	},

	/** A client rated the provider (whole project or one stage). */
	async ratingReceived(p: { providerId: string; rating: number; reviewId: string; projectId?: string | null; stage?: boolean }) {
		await safely('ratingReceived', () => notificationService.createAndEmit({
			userId: p.providerId,
			title: p.stage ? 'تقييم جديد على مرحلة' : 'وصلك تقييم جديد',
			message: `قيّمك العميل بـ ${p.rating} من 5${p.stage ? ' على إحدى مراحل المشروع' : ''}.`,
			category: NotificationCategory.PROJECTS,
			type: 'RATING_RECEIVED',
			// The rating sits inside its project (the rating page shows the client's review of this provider, read-only); without a project the public profile lists it.
			actionUrl: p.projectId ? (p.stage ? PROVIDER_ROUTES.projectProgress(p.projectId) : PROVIDER_ROUTES.rating(p.projectId)) : PROVIDER_ROUTES.reviews,
			actionText: p.projectId ? 'عرض التقييم' : 'عرض التقييمات',
			metadata: { reviewId: p.reviewId, rating: p.rating, ...(p.projectId ? { projectId: p.projectId } : {}) }
		}));
	},

	/** The provider's withdrawal changed state. Marketer (commission) withdrawals are handed to the marketer helper instead. */
	async withdrawal(withdrawalId: string, event: ProviderWithdrawalEvent) {
		await safely(`withdrawal ${event}`, async () => {
			const w = await prisma.withdrawal.findUnique({ where: { id: withdrawalId }, select: { id: true, userId: true, amount: true, currency: true, rejectionReason: true } });
			if (!w) return;
			const owner = await prisma.user.findUnique({ where: { id: w.userId }, select: { accountType: true, roles: true, activeRole: true, affiliateProfile: { select: { id: true } } } });
			if (!owner) return;
			// a marketer's withdrawal is announced by marketerNotifications (called next to this one at every call site)
			if (owner.affiliateProfile && !isProviderUser(owner)) return;
			const amount = formatMoney(w.amount, w.currency);
			const copy: Record<ProviderWithdrawalEvent, { title: string; message: string }> = {
				REQUESTED: { title: 'تم استلام طلب السحب', message: `طلب سحب ${amount} قيد مراجعة الإدارة، ولا يُخصم من رصيدك حتى تعتمده.` },
				APPROVED: { title: 'تم اعتماد طلب السحب', message: `اعتمدت الإدارة طلب سحب ${amount}.` },
				REJECTED: { title: 'تم رفض طلب السحب', message: `رُفض طلب سحب ${amount}.${w.rejectionReason ? ` السبب: ${short(w.rejectionReason, 200)}` : ''}` },
				PAID: { title: 'تم تحويل مبلغ السحب', message: `تم تحويل ${amount} إلى حساب PayPal الخاص بك.` },
				FAILED: { title: 'تعذّر تحويل مبلغ السحب', message: `تعذّر إتمام تحويل ${amount} عبر PayPal ولم يُخصم أي مبلغ. طلب السحب ما زال معتمدًا.` },
				REVERSED: { title: 'أُعيد مبلغ السحب من PayPal', message: `أبلغت PayPal باسترجاع تحويل ${amount} بعد إتمامه. تواصل مع الدعم لمعرفة التفاصيل.` }
			};
			await notificationService.createAndEmit({ userId: w.userId, ...copy[event], category: NotificationCategory.FINANCIAL, type: `WITHDRAWAL_${event}`, actionUrl: PROVIDER_ROUTES.withdraw, actionText: 'عرض طلبات السحب', metadata: { withdrawalId: w.id, status: event } });
		});
	},

	/** The payout email was changed (confirmed by OTP). */
	async paypalEmailChanged(userId: string) {
		await safely('paypalEmailChanged', () => notificationService.createAndEmit({
			userId,
			title: 'تم تغيير بريد PayPal',
			message: 'تم تغيير بريد PayPal لاستلام المدفوعات، وسحب PayPal مجمّد 24 ساعة. إن لم تكن أنت، تواصل مع الدعم فورًا.',
			category: NotificationCategory.FINANCIAL,
			type: 'PAYPAL_EMAIL_CHANGED',
			actionUrl: PROVIDER_ROUTES.paypalSettings,
			actionText: 'مراجعة بريد PayPal'
		}));
	},

	/** The client answered an amendment request the provider raised. */
	async amendmentAnswered(p: { providerId: string; projectId: string; amendmentId: string; title: string; decision: 'approve' | 'reject' }) {
		const approved = p.decision === 'approve';
		await safely('amendmentAnswered', () => notificationService.createAndEmit({
			userId: p.providerId,
			title: approved ? 'وافق العميل وطُبّق التعديل على العقد' : 'رفض العميل طلب التعديل',
			message: `${approved ? 'وافق' : 'رفض'} العميل على طلب التعديل «${short(p.title)}». ${approved ? 'وطُبّق التعديل على العقد.' : 'ولم يتغيّر شيء في العقد.'}`,
			category: NotificationCategory.PROJECTS,
			type: 'PROJECT_AMENDMENT',
			actionUrl: PROVIDER_ROUTES.projectProgress(p.projectId),
			actionText: 'عرض المشروع',
			metadata: { projectId: p.projectId, amendmentId: p.amendmentId, decision: p.decision }
		}));
	},

	/** The client withdrew an amendment request they had raised: nothing changed and any payment authorization was voided. */
	async amendmentCancelled(p: { providerId: string; projectId: string; amendmentId: string; title: string }) {
		await safely('amendmentCancelled', () => notificationService.createAndEmit({
			userId: p.providerId,
			title: 'ألغى العميل طلب التعديل',
			message: `ألغى العميل طلب التعديل «${short(p.title)}». لم يتغيّر شيء في العقد ولا في الضمان.`,
			category: NotificationCategory.PROJECTS,
			type: 'PROJECT_AMENDMENT',
			actionUrl: PROVIDER_ROUTES.projectProgress(p.projectId),
			actionText: 'عرض المشروع',
			metadata: { projectId: p.projectId, amendmentId: p.amendmentId, decision: 'cancelled' }
		}));
	},

	/** The client asked to negotiate the provider's offer (the provider has to answer on the negotiation page). */
	async negotiationRequested(p: { providerId: string; offerId: string; projectId: string; requestTitle?: string | null }) {
		const title = short(p.requestTitle);
		await safely('negotiationRequested', () => notificationService.createAndEmit({
			userId: p.providerId,
			title: 'طلب العميل التفاوض على عرضك',
			message: `طلب العميل التفاوض على عرضك${title ? ` في «${title}»` : ''}. راجع الطلب وأرسل عرضًا مضادًا أو اعتذر عنه.`,
			category: NotificationCategory.OFFERS,
			type: 'OFFER_NEGOTIATION_REQUESTED',
			actionUrl: PROVIDER_ROUTES.offerNegotiate(p.offerId),
			actionText: 'عرض التفاوض',
			metadata: { offerId: p.offerId, projectId: p.projectId }
		}));
	},

	/** The client selected the provider's offer; the contract now waits for the client's signature and escrow deposit (no signing action for the provider yet). */
	async offerSelected(p: { providerId: string; offerId: string; projectId: string; requestTitle?: string | null }) {
		const title = short(p.requestTitle);
		await safely('offerSelected', () => notificationService.createAndEmit({
			userId: p.providerId,
			title: 'اختار العميل عرضك',
			message: `اختار العميل عرضك${title ? ` في «${title}»` : ''}. العقد الآن بانتظار توقيع العميل وإيداع الضمان، وسنخبرك عندما يحين دورك للتوقيع.`,
			category: NotificationCategory.OFFERS,
			type: 'OFFER_SELECTED',
			actionUrl: PROVIDER_ROUTES.offers,
			actionText: 'عرض عروضي',
			metadata: { offerId: p.offerId, projectId: p.projectId }
		}));
	},

	/** The client accepted the provider's counter-offer: the offer now carries the counter's price and duration. */
	async counterAccepted(p: { providerId: string; offerId: string; projectId: string; projectTitle?: string | null; price: number; deliveryDays: number }) {
		const title = short(p.projectTitle);
		await safely('counterAccepted', () => notificationService.createAndEmit({
			userId: p.providerId,
			title: 'قبل العميل عرضك المضاد',
			message: `قبل العميل عرضك المضاد${title ? ` على «${title}»` : ''}: ${p.price} $ خلال ${p.deliveryDays} يومًا. أصبحت هذه شروط عرضك، وبانتظار اختيار العميل لك والتوقيع.`,
			category: NotificationCategory.OFFERS,
			type: 'OFFER_COUNTER_ACCEPTED',
			actionUrl: PROVIDER_ROUTES.offerNegotiate(p.offerId),
			actionText: 'عرض العرض',
			metadata: { projectId: p.projectId, offerId: p.offerId, price: p.price, deliveryDays: p.deliveryDays }
		}));
	},

	/** An admin decided the provider's identity (KYC) review. */
	async kycDecided(p: { providerId: string; decision: 'APPROVED' | 'REJECTED'; reason?: string | null }) {
		const approved = p.decision === 'APPROVED';
		await safely('kycDecided', () => notificationService.createAndEmit({
			userId: p.providerId,
			title: approved ? 'تم اعتماد توثيق هويتك' : 'تم رفض توثيق هويتك',
			message: approved ? 'اعتمدت الإدارة مستندات هويتك وأصبح حسابك موثّقًا.' : `رفضت الإدارة مستندات الهوية.${p.reason ? ` السبب: ${short(p.reason, 200)}` : ''} يمكنك تحديث المستندات وإعادة الإرسال.`,
			category: NotificationCategory.PROJECTS,
			type: approved ? 'KYC_APPROVED' : 'KYC_REJECTED',
			actionUrl: PROVIDER_ROUTES.kyc,
			actionText: approved ? 'عرض بياناتي' : 'تحديث المستندات',
			metadata: { decision: p.decision }
		}));
	},

	/** An admin decided a specialty that was under review (specialty decision endpoint). */
	async specialtyDecided(p: { providerId: string; specialtyName?: string | null; decision: 'APPROVED' | 'REJECTED'; reason?: string | null }) {
		const approved = p.decision === 'APPROVED';
		const name = short(p.specialtyName);
		await safely('specialtyDecided', () => notificationService.createAndEmit({
			userId: p.providerId,
			title: approved ? 'تم اعتماد تخصصك' : 'تم رفض تخصصك',
			message: `${approved ? 'اعتمدت' : 'رفضت'} الإدارة تخصص${name ? ` «${name}»` : 'ك'}.${p.reason ? ` ${approved ? 'ملاحظة' : 'السبب'}: ${short(p.reason, 200)}` : ''}`,
			category: NotificationCategory.PROJECTS,
			type: approved ? 'SPECIALTY_APPROVED' : 'SPECIALTY_REJECTED',
			actionUrl: PROVIDER_ROUTES.specialties,
			actionText: 'عرض تخصصاتي',
			metadata: { decision: p.decision }
		}));
	},

	/** An admin approved / rejected an accreditation sample the provider uploaded. */
	async accreditationDecided(p: { providerId: string; sampleId: string; sampleTitle?: string | null; decision: 'APPROVED' | 'REJECTED'; reason?: string | null }) {
		const approved = p.decision === 'APPROVED';
		const title = short(p.sampleTitle);
		await safely('accreditationDecided', () => notificationService.createAndEmit({
			userId: p.providerId,
			title: approved ? 'تم اعتماد نموذج الاعتماد' : 'تم رفض نموذج الاعتماد',
			message: `${approved ? 'اعتمدت' : 'رفضت'} الإدارة نموذج الاعتماد${title ? ` «${title}»` : ''}.${!approved && p.reason ? ` السبب: ${short(p.reason, 200)}` : ''}`,
			category: NotificationCategory.PROJECTS,
			type: approved ? 'ACCREDITATION_APPROVED' : 'ACCREDITATION_REJECTED',
			actionUrl: PROVIDER_ROUTES.accreditation(p.sampleId),
			actionText: 'عرض النموذج',
			metadata: { sampleId: p.sampleId, decision: p.decision }
		}));
	},

	/** An admin asked the provider to complete the request (not a rejection): the note addressed to the provider is quoted, the internal note never. */
	async accreditationCompletionRequested(p: { providerId: string; sampleId: string; sampleTitle?: string | null; note?: string | null }) {
		const title = short(p.sampleTitle);
		await safely('accreditationCompletionRequested', () => notificationService.createAndEmit({
			userId: p.providerId,
			title: 'مطلوب استكمال بيانات طلب الاعتماد',
			message: `طلبت الإدارة استكمال بيانات نموذج الاعتماد${title ? ` «${title}»` : ''}.${p.note ? ` الملاحظة: ${short(p.note, 200)}` : ''}`,
			category: NotificationCategory.PROJECTS,
			type: 'ACCREDITATION_COMPLETION_REQUESTED',
			actionUrl: PROVIDER_ROUTES.accreditation(p.sampleId),
			actionText: 'استكمال البيانات',
			metadata: { sampleId: p.sampleId }
		}));
	},

	/** Stored provider notifications that were created inside another write: deliver them through the provider's channels. */
	async deliverStored(ids: string[]) {
		for (const id of ids) await safely('deliverStored', () => notificationService.emitStored(id));
	}
};
