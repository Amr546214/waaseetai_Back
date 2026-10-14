import { ProposalStatus } from '@prisma/client';
import { clientNotifications, clientNotificationFor } from './client-notifications.service';
import { prisma } from '../config/db';
import { AppError } from '../utils/app-error';
import {
	NEG_PREFIX, MAX_OFFER_PRICE, MAX_OFFER_DAYS, MAX_COUNTER_NOTE,
	buildProviderEntry, deriveNegotiationState, isClearRequest, parseNegotiationMessage, readNegotiationEntries, type NegotiationEntry
} from '../utils/offer-negotiation';

// Provider side of offer negotiation: withdraw, counter, and answer (reject) a client's negotiation request.
// Every decision changes the canonical ProjectProposal AND its legacy Proposal mirror together, in one transaction, or fails as a whole.
// No contract / escrow / stage / client-page involvement. No table: the conversation's structured WS_NEGOTIATION messages are the state.

const WITHDRAWABLE: ProposalStatus[] = [ProposalStatus.PENDING, ProposalStatus.SUBMITTED, ProposalStatus.UNDER_NEGOTIATION];
const FREE_TEXT_MESSAGE = 'اتفقوا في المحادثة ثم أرسل عرضًا مضادًا واضحًا';
const NEG_WINDOW = 80; // structured entries are scanned newest-first over this many recent messages

const mirrorWhere = (providerId: string, projectId: string) => ({ providerId, OR: [{ projectId }, { clientRequestId: projectId }] });

type Tx = Parameters<Parameters<typeof prisma.$transaction>[0]>[0];

export interface OfferNegotiationView {
	offerId: string;
	projectId: string;
	status: string;
	canWithdraw: boolean;
	canCounter: boolean;
	canReject: boolean;
	counterPending: boolean;
	/** The client's newest unanswered request (only while the offer is under negotiation). */
	request: { messageId: string; price: number | null; deliveryDays: number | null; notes: string; clear: boolean; createdAt: string } | null;
	/** The provider's own pending counter (waiting for the client), otherwise null. */
	counter: { messageId: string; price: number | null; deliveryDays: number | null; notes: string; createdAt: string } | null;
	/** Why a free-text request cannot be acted on automatically (shown instead of buttons). */
	hint: string | null;
}

class ProviderOfferNegotiationService {
	private async loadOffer(providerId: string, key: { offerId?: string; projectId?: string }) {
		const offer = await prisma.projectProposal.findFirst({
			where: key.offerId ? { id: key.offerId, providerId } : { projectId: key.projectId, providerId },
			select: { id: true, projectId: true, providerId: true, status: true, project: { select: { clientId: true, title: true } } }
		});
		if (!offer) throw new AppError('العرض غير موجود', 404);
		return offer;
	}

	private async recentEntries(client: Pick<Tx, 'conversation'> & Pick<Tx, 'message'>, projectId: string, providerId: string) {
		const conversation = await client.conversation.findUnique({ where: { projectId_providerId: { projectId, providerId } }, select: { id: true } });
		if (!conversation) return { conversationId: null as string | null, entries: [] as NegotiationEntry[] };
		const rows = await client.message.findMany({
			where: { conversationId: conversation.id, content: { startsWith: NEG_PREFIX } },
			orderBy: { createdAt: 'desc' },
			take: NEG_WINDOW,
			select: { id: true, senderId: true, content: true, createdAt: true }
		});
		return { conversationId: conversation.id, entries: readNegotiationEntries(rows, providerId) };
	}

	// Read-only view the offers / negotiate / messages pages render from. Nothing here is written.
	async getView(providerId: string, key: { offerId?: string; projectId?: string }): Promise<OfferNegotiationView> {
		const offer = await this.loadOffer(providerId, key);
		const underNegotiation = offer.status === ProposalStatus.UNDER_NEGOTIATION;
		let counterPending = false;
		let open: NegotiationEntry | null = null;
		let pending: NegotiationEntry | null = null;
		if (underNegotiation) {
			const { entries } = await this.recentEntries(prisma, offer.projectId, providerId);
			const state = deriveNegotiationState(entries, offer.id);
			counterPending = state.counterPending;
			open = state.openRequest;
			pending = state.pendingCounter;
		}
		const clear = !!open && isClearRequest(open);
		return {
			offerId: offer.id,
			projectId: offer.projectId,
			status: offer.status,
			canWithdraw: WITHDRAWABLE.includes(offer.status),
			canCounter: underNegotiation && !counterPending,
			canReject: underNegotiation && clear,
			counterPending,
			request: open ? { messageId: open.messageId, price: open.price, deliveryDays: open.deliveryDays, notes: open.notes, clear, createdAt: open.createdAt.toISOString() } : null,
			counter: pending ? { messageId: pending.messageId, price: pending.price, deliveryDays: pending.deliveryDays, notes: pending.notes, createdAt: pending.createdAt.toISOString() } : null,
			hint: open && !clear ? FREE_TEXT_MESSAGE : null
		};
	}

	// The ProjectProposal gate: only a row still in one of `from` and owned by this provider is touched, otherwise the whole transaction rolls back.
	private async moveOffer(tx: Tx, offer: { id: string; projectId: string }, providerId: string, from: ProposalStatus[], to: ProposalStatus) {
		const gate = await tx.projectProposal.updateMany({ where: { id: offer.id, providerId, status: { in: from } }, data: { status: to } });
		if (gate.count !== 1) throw new AppError('حالة العرض تغيّرت، حدّث الصفحة وحاول مرة أخرى', 409);
		const mirrors = await tx.proposal.findMany({ where: mirrorWhere(providerId, offer.projectId), select: { id: true, status: true } });
		if (mirrors.some((m) => !from.includes(m.status))) throw new AppError('حالة العرض غير متسقة، لا يمكن تنفيذ الإجراء', 409);
		if (mirrors.length) await tx.proposal.updateMany({ where: { id: { in: mirrors.map((m) => m.id) } }, data: { status: to } });
	}

	// Locks the offer row for the rest of the transaction (same pattern as the amendment request) so two simultaneous counters cannot both pass the pending check.
	private async lockOffer(tx: Tx, offerId: string, providerId: string, status: ProposalStatus) {
		const lock = await tx.projectProposal.updateMany({ where: { id: offerId, providerId, status }, data: { updatedAt: new Date() } });
		if (lock.count !== 1) throw new AppError('لا يمكن تنفيذ هذا الإجراء في الحالة الحالية للعرض', 409);
	}

	async withdraw(providerId: string, offerId: string) {
		const offer = await this.loadOffer(providerId, { offerId });
		if (!WITHDRAWABLE.includes(offer.status)) throw new AppError('لا يمكن سحب هذا العرض في حالته الحالية', 409);
		let notificationId: string | null = null;
		await prisma.$transaction(async (tx) => {
			const contract = await tx.contract.findUnique({ where: { projectId: offer.projectId }, select: { offerId: true, providerId: true } });
			if (contract && contract.providerId === providerId) throw new AppError('لا يمكن سحب العرض بعد اختيار العميل له وبدء التعاقد', 409);
			await this.moveOffer(tx, offer, providerId, WITHDRAWABLE, ProposalStatus.CANCELLED);
			notificationId = (await tx.notification.create({ data: clientNotificationFor.offerWithdrawn({ clientId: offer.project.clientId, requestId: offer.projectId, offerId: offer.id, requestTitle: offer.project.title }) })).id;
		});
		await clientNotifications.deliverStored([notificationId]);
		return { offerId: offer.id, status: ProposalStatus.CANCELLED };
	}

	async counter(providerId: string, offerId: string, input: { price?: unknown; deliveryDays?: unknown; note?: unknown }) {
		const price = input.price;
		if (typeof price !== 'number' || !Number.isFinite(price) || price <= 0 || price > MAX_OFFER_PRICE) throw new AppError('أدخل سعرًا صحيحًا للعرض المضاد', 400);
		const days = input.deliveryDays;
		if (typeof days !== 'number' || !Number.isInteger(days) || days < 1 || days > MAX_OFFER_DAYS) throw new AppError('أدخل مدة تنفيذ صحيحة بالأيام للعرض المضاد', 400);
		if (input.note !== undefined && input.note !== null && typeof input.note !== 'string') throw new AppError('الملاحظة غير صالحة', 400);
		const note = (input.note as string | undefined)?.trim() || '';
		if (note.length > MAX_COUNTER_NOTE) throw new AppError(`الملاحظة طويلة جدًا (الحد الأقصى ${MAX_COUNTER_NOTE} حرفًا)`, 400);

		const offer = await this.loadOffer(providerId, { offerId });
		if (offer.status !== ProposalStatus.UNDER_NEGOTIATION) throw new AppError('لا يمكن إرسال عرض مضاد إلا بعد أن يبدأ العميل التفاوض على العرض', 409);

		const result = await prisma.$transaction(async (tx) => {
			await this.lockOffer(tx, offer.id, providerId, ProposalStatus.UNDER_NEGOTIATION);
			const { conversationId, entries } = await this.recentEntries(tx, offer.projectId, providerId);
			if (!conversationId) throw new AppError('لا توجد محادثة تفاوض لهذا العرض بعد', 409);
			const state = deriveNegotiationState(entries, offer.id);
			if (state.counterPending) throw new AppError('لديك عرض مضاد معلّق بانتظار رد العميل', 409);
			const message = await tx.message.create({
				data: {
					conversationId,
					senderId: providerId,
					type: 'TEXT',
					status: 'SENT',
					content: buildProviderEntry('PROVIDER_COUNTER', { offerId: offer.id, price, deliveryDays: days, notes: note, replyToMessageId: state.openRequest?.messageId })
				},
				select: { id: true }
			});
			const notification = await tx.notification.create({ data: clientNotificationFor.offerCounter({ clientId: offer.project.clientId, requestId: offer.projectId, offerId: offer.id, messageId: message.id, requestTitle: offer.project.title, price, deliveryDays: days }) });
			return { offerId: offer.id, messageId: message.id, price, deliveryDays: days, notificationId: notification.id };
		});
		await clientNotifications.deliverStored([result.notificationId]);
		const { notificationId: _n, ...view } = result;
		return view;
	}

	// Declines the client's newest request: the offer goes back to SUBMITTED with its ORIGINAL values and the client is told.
	async reject(providerId: string, offerId: string, input: { messageId?: unknown }) {
		if (typeof input.messageId !== 'string' || !input.messageId) throw new AppError('حدد طلب التفاوض المراد الرد عليه', 400);
		const offer = await this.loadOffer(providerId, { offerId });
		if (offer.status !== ProposalStatus.UNDER_NEGOTIATION) throw new AppError('لا يوجد تفاوض جارٍ على هذا العرض', 409);

		const result = await prisma.$transaction(async (tx) => {
			await this.lockOffer(tx, offer.id, providerId, ProposalStatus.UNDER_NEGOTIATION);
			const { conversationId, entries } = await this.recentEntries(tx, offer.projectId, providerId);
			if (!conversationId) throw new AppError('لا توجد محادثة تفاوض لهذا العرض', 409);
			const open = deriveNegotiationState(entries, offer.id).openRequest;
			if (!open || open.messageId !== input.messageId) throw new AppError('تم الرد على هذا الطلب مسبقًا أو توجد رسالة تفاوض أحدث', 409);
			if (!isClearRequest(open)) throw new AppError(FREE_TEXT_MESSAGE, 422);
			// the request must really be authored by this project's client (never trust a stray message)
			const source = await tx.message.findFirst({ where: { id: open.messageId, conversationId }, select: { senderId: true, content: true } });
			if (!source || source.senderId !== offer.project.clientId || !parseNegotiationMessage(source.content, false)) throw new AppError('طلب التفاوض غير صالح', 409);

			await this.moveOffer(tx, offer, providerId, [ProposalStatus.UNDER_NEGOTIATION], ProposalStatus.SUBMITTED);
			const reply = await tx.message.create({
				data: { conversationId, senderId: providerId, type: 'TEXT', status: 'SENT', content: buildProviderEntry('PROVIDER_REJECT', { offerId: offer.id, replyToMessageId: open.messageId }) },
				select: { id: true }
			});
			const notification = await tx.notification.create({ data: clientNotificationFor.negotiationDeclined({ clientId: offer.project.clientId, requestId: offer.projectId, offerId: offer.id, messageId: reply.id, requestTitle: offer.project.title }) });
			return { offerId: offer.id, status: ProposalStatus.SUBMITTED, messageId: reply.id, notificationId: notification.id };
		});
		await clientNotifications.deliverStored([result.notificationId]);
		const { notificationId: _n, ...view } = result;
		return view;
	}
}

export const providerOfferNegotiationService = new ProviderOfferNegotiationService();
