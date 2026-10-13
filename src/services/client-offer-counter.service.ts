import { ContractStatus, ProposalStatus, RequestStatus } from '@prisma/client';
import { prisma } from '../config/db';
import { AppError } from '../utils/app-error';
import { round2, splitByWeights } from '../utils/order-discount';
import {
	NEG_PREFIX, MAX_OFFER_PRICE, MAX_OFFER_DAYS,
	buildClientAcceptEntry, buildClientDeclineEntry, deriveNegotiationState, readNegotiationEntries, type NegotiationEntry
} from '../utils/offer-negotiation';
import { providerNotifications } from './provider-notifications.service';

// Client side of a counter-offer: see the provider's pending counter and ACCEPT it.
// Accepting rewrites the canonical ProjectProposal AND its legacy Proposal mirror (price, days, stage amounts/days) in ONE transaction and puts the
// offer back to SUBMITTED with the NEW terms, so selectOffer / the contract / the escrow are built on the counter, never on the original price.
// No table and no contract here: the conversation's structured WS_NEGOTIATION messages are the state (the acceptance is one more such message).

const NEG_WINDOW = 80;
const OPEN_REQUEST_STATUSES: RequestStatus[] = [RequestStatus.OPEN, RequestStatus.PENDING_SIGNATURE];

type Tx = Parameters<Parameters<typeof prisma.$transaction>[0]>[0];

export interface ClientCounterView {
	offerId: string;
	legacyOfferId: string | null;
	status: string;
	/** The provider's pending counter (the newest negotiation entry), otherwise null. */
	counter: { messageId: string; price: number | null; deliveryDays: number | null; notes: string; createdAt: string; clear: boolean } | null;
	canAccept: boolean;
}

/** Day split that always sums exactly to `total` (largest remainder), weights = the current stage days. */
export function splitDays(weights: number[], total: number): number[] {
	if (weights.length === 0) return [];
	const sum = weights.reduce((s, w) => s + w, 0);
	const exact = weights.map((w) => (sum > 0 ? (total * w) / sum : total / weights.length));
	const parts = exact.map(Math.floor);
	let left = total - parts.reduce((s, p) => s + p, 0);
	const order = exact.map((v, i) => ({ i, frac: v - Math.floor(v) })).sort((a, b) => b.frac - a.frac || a.i - b.i);
	for (let k = 0; left > 0; k = (k + 1) % order.length, left--) parts[order[k].i]++;
	return parts;
}

export interface ClientNegotiationView {
	state: 'NONE' | 'REQUEST_SENT' | 'COUNTER_PENDING';
	counter: { messageId: string; price: number | null; deliveryDays: number | null; notes: string; createdAt: string } | null;
}

class ClientOfferCounterService {
	/** Negotiation state per provider for one request (one query for all providers). `offers` maps providerId -> canonical ProjectProposal id. */
	async viewsForRequest(requestId: string, offers: Map<string, string>): Promise<Map<string, ClientNegotiationView>> {
		const out = new Map<string, ClientNegotiationView>();
		if (offers.size === 0) return out;
		const rows = await prisma.message.findMany({
			where: { content: { startsWith: NEG_PREFIX }, conversation: { projectId: requestId, providerId: { in: [...offers.keys()] } } },
			orderBy: { createdAt: 'desc' },
			take: 200,
			select: { id: true, senderId: true, content: true, createdAt: true, conversation: { select: { providerId: true } } }
		});
		for (const [providerId, offerId] of offers) {
			const state = deriveNegotiationState(readNegotiationEntries(rows.filter(r => r.conversation.providerId === providerId), providerId), offerId);
			const pending = state.pendingCounter;
			out.set(providerId, {
				state: pending ? 'COUNTER_PENDING' : state.openRequest ? 'REQUEST_SENT' : 'NONE',
				counter: pending ? { messageId: pending.messageId, price: pending.price, deliveryDays: pending.deliveryDays, notes: pending.notes, createdAt: pending.createdAt.toISOString() } : null
			});
		}
		return out;
	}

	// The request must belong to this client; the offer id may be the canonical ProjectProposal id or its legacy Proposal mirror id (the client UI carries both).
	private async loadOffer(userId: string, requestId: string, offerId: string) {
		const request = await prisma.clientRequest.findFirst({ where: { id: requestId, clientProfile: { userId } }, select: { id: true, title: true, status: true } });
		if (!request) throw new AppError('طلب المشروع غير موجود أو لا تملك صلاحية الوصول إليه', 404);
		const legacy = await prisma.proposal.findFirst({ where: { id: offerId, OR: [{ clientRequestId: requestId }, { projectId: requestId }] }, select: { id: true, providerId: true } });
		const offer = await prisma.projectProposal.findFirst({
			where: legacy ? { projectId: requestId, providerId: legacy.providerId } : { id: offerId, projectId: requestId },
			select: { id: true, projectId: true, providerId: true, status: true, totalPrice: true, deliveryDays: true, milestones: { select: { id: true, stepOrder: true, days: true, amount: true, percentage: true }, orderBy: { stepOrder: 'asc' } } }
		});
		if (!offer) throw new AppError('العرض المحدد غير موجود أو لا يتبع هذا الطلب', 404);
		return { request, offer, legacyId: legacy?.id ?? null };
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

	private isClearCounter(c: NegotiationEntry | null): c is NegotiationEntry & { price: number; deliveryDays: number } {
		return !!c && c.price !== null && c.deliveryDays !== null && c.price <= MAX_OFFER_PRICE && Number.isInteger(c.deliveryDays) && c.deliveryDays >= 1 && c.deliveryDays <= MAX_OFFER_DAYS;
	}

	// Read-only: what the client's page renders the accept action from.
	async getView(userId: string, requestId: string, offerId: string): Promise<ClientCounterView> {
		const { request, offer, legacyId } = await this.loadOffer(userId, requestId, offerId);
		let pending: NegotiationEntry | null = null;
		if (offer.status === ProposalStatus.UNDER_NEGOTIATION) {
			const { entries } = await this.recentEntries(prisma, offer.projectId, offer.providerId);
			pending = deriveNegotiationState(entries, offer.id).pendingCounter;
		}
		return {
			offerId: offer.id,
			legacyOfferId: legacyId,
			status: offer.status,
			counter: pending ? { messageId: pending.messageId, price: pending.price, deliveryDays: pending.deliveryDays, notes: pending.notes, createdAt: pending.createdAt.toISOString(), clear: this.isClearCounter(pending) } : null,
			canAccept: this.isClearCounter(pending) && OPEN_REQUEST_STATUSES.includes(request.status as RequestStatus)
		};
	}

	async accept(userId: string, requestId: string, offerId: string, input: { messageId?: unknown }) {
		if (typeof input.messageId !== 'string' || !input.messageId) throw new AppError('حدد العرض المضاد المراد قبوله', 400);
		const messageId = input.messageId;
		const { request, offer, legacyId } = await this.loadOffer(userId, requestId, offerId);

		if (!OPEN_REQUEST_STATUSES.includes(request.status as RequestStatus)) throw new AppError('لا يمكن قبول عرض مضاد على هذا الطلب في حالته الحالية', 409);
		if (offer.status === ProposalStatus.CANCELLED) throw new AppError('سحب مقدم الخدمة هذا العرض ولا يمكن قبول عرضه المضاد', 409);
		if (offer.status !== ProposalStatus.UNDER_NEGOTIATION) throw new AppError('لا يوجد عرض مضاد معلّق على هذا العرض (ربما قُبل مسبقًا أو تغيّرت حالة العرض)، حدّث الصفحة', 409);

		const result = await prisma.$transaction(async (tx) => {
			// Locks the offer row for the rest of the transaction and gates on the status: two simultaneous accepts (or an accept racing a withdraw) cannot both win.
			const lock = await tx.projectProposal.updateMany({ where: { id: offer.id, providerId: offer.providerId, status: ProposalStatus.UNDER_NEGOTIATION }, data: { updatedAt: new Date() } });
			if (lock.count !== 1) throw new AppError('حالة العرض تغيّرت (سُحب أو قُبل العرض المضاد مسبقًا)، حدّث الصفحة', 409);

			const contract = await tx.contract.findUnique({ where: { projectId: requestId }, select: { status: true } });
			if (contract && contract.status !== ContractStatus.PENDING_CLIENT_SIGNATURE) throw new AppError('تم توقيع العقد لهذا الطلب، ولا يمكن تغيير شروط العرض', 409);

			const { conversationId, entries } = await this.recentEntries(tx, offer.projectId, offer.providerId);
			if (!conversationId) throw new AppError('لا توجد محادثة تفاوض لهذا العرض', 409);
			const pending = deriveNegotiationState(entries, offer.id).pendingCounter;
			if (!pending) throw new AppError('لا يوجد عرض مضاد معلّق على هذا العرض', 409);
			if (pending.messageId !== messageId) throw new AppError('هذا العرض المضاد لم يعد الأحدث، راجع آخر عرض مضاد من مقدم الخدمة', 409);
			if (!this.isClearCounter(pending)) throw new AppError('العرض المضاد لا يحتوي على سعر ومدة واضحين، اتفق مع مقدم الخدمة في المحادثة على عرض مضاد واضح', 422);
			// the counter must really be the provider's own structured entry (readNegotiationEntries already ignores any other sender)
			const source = await tx.message.findFirst({ where: { id: pending.messageId, conversationId }, select: { senderId: true } });
			if (!source || source.senderId !== offer.providerId) throw new AppError('العرض المضاد غير صالح', 409);

			const price = round2(pending.price);
			const days = pending.deliveryDays;

			const mirrors = await tx.proposal.findMany({ where: { providerId: offer.providerId, OR: [{ projectId: requestId }, { clientRequestId: requestId }] }, select: { id: true, status: true } });
			if (mirrors.some((m) => m.status !== ProposalStatus.UNDER_NEGOTIATION)) throw new AppError('حالة العرض غير متسقة، لا يمكن قبول العرض المضاد', 409);

			// canonical offer: new total + days, back to SUBMITTED (the client can now select / sign it)
			const moved = await tx.projectProposal.updateMany({
				where: { id: offer.id, providerId: offer.providerId, status: ProposalStatus.UNDER_NEGOTIATION },
				data: { totalPrice: price, deliveryDays: days, status: ProposalStatus.SUBMITTED }
			});
			if (moved.count !== 1) throw new AppError('حالة العرض تغيّرت، حدّث الصفحة وحاول مرة أخرى', 409);
			// stages keep their proportions: amounts re-split so they sum EXACTLY to the new price, days so they sum to the new duration (percentages are unchanged)
			if (offer.milestones.length) {
				const byAmount = offer.milestones.some((x) => x.amount > 0);
				const amounts = splitByWeights(offer.milestones.map((m) => (byAmount ? m.amount : m.percentage)), price);
				const stageDays = splitDays(offer.milestones.map((m) => m.days), days);
				for (const [i, m] of offer.milestones.entries()) await tx.proposalMilestone.update({ where: { id: m.id }, data: { amount: amounts[i], days: stageDays[i] } });
			}
			// legacy mirror: the same terms
			if (mirrors.length) await tx.proposal.updateMany({ where: { id: { in: mirrors.map((m) => m.id) } }, data: { price, deliveryDays: days, status: ProposalStatus.SUBMITTED } });

			const reply = await tx.message.create({
				data: { conversationId, senderId: userId, type: 'TEXT', status: 'SENT', content: buildClientAcceptEntry({ offerId: offer.id, price, deliveryDays: days, counterMessageId: pending.messageId }) },
				select: { id: true }
			});
			return { price, deliveryDays: days, messageId: reply.id };
		});

		// the provider is told after the commit; a notification failure never fails the acceptance
		await providerNotifications.counterAccepted({ providerId: offer.providerId, offerId: offer.id, projectId: requestId, projectTitle: request.title, price: result.price, deliveryDays: result.deliveryDays });
		return { offerId: offer.id, legacyOfferId: legacyId, status: ProposalStatus.SUBMITTED, price: result.price, deliveryDays: result.deliveryDays, messageId: result.messageId };
	}

	// Declining keeps the offer with its ORIGINAL terms (back to SUBMITTED); the client may then send a new negotiation request or select the offer as it is.
	async decline(userId: string, requestId: string, offerId: string, input: { messageId?: unknown }) {
		if (typeof input.messageId !== 'string' || !input.messageId) throw new AppError('حدد العرض المضاد المراد رفضه', 400);
		const messageId = input.messageId;
		const { request, offer } = await this.loadOffer(userId, requestId, offerId);

		if (!OPEN_REQUEST_STATUSES.includes(request.status as RequestStatus)) throw new AppError('لا يمكن الرد على عرض مضاد لهذا الطلب في حالته الحالية', 409);
		if (offer.status === ProposalStatus.CANCELLED) throw new AppError('سحب مقدم الخدمة هذا العرض', 409);
		if (offer.status !== ProposalStatus.UNDER_NEGOTIATION) throw new AppError('لا يوجد عرض مضاد معلّق على هذا العرض (ربما تم الرد عليه مسبقًا)، حدّث الصفحة', 409);

		await prisma.$transaction(async (tx) => {
			const lock = await tx.projectProposal.updateMany({ where: { id: offer.id, providerId: offer.providerId, status: ProposalStatus.UNDER_NEGOTIATION }, data: { updatedAt: new Date() } });
			if (lock.count !== 1) throw new AppError('حالة العرض تغيّرت (سُحب أو تم الرد على العرض المضاد مسبقًا)، حدّث الصفحة', 409);
			const { conversationId, entries } = await this.recentEntries(tx, offer.projectId, offer.providerId);
			if (!conversationId) throw new AppError('لا توجد محادثة تفاوض لهذا العرض', 409);
			const pending = deriveNegotiationState(entries, offer.id).pendingCounter;
			if (!pending) throw new AppError('لا يوجد عرض مضاد معلّق على هذا العرض', 409);
			if (pending.messageId !== messageId) throw new AppError('هذا العرض المضاد لم يعد الأحدث، راجع آخر عرض مضاد من مقدم الخدمة', 409);
			const mirrors = await tx.proposal.findMany({ where: { providerId: offer.providerId, OR: [{ projectId: requestId }, { clientRequestId: requestId }] }, select: { id: true, status: true } });
			if (mirrors.some((m) => m.status !== ProposalStatus.UNDER_NEGOTIATION)) throw new AppError('حالة العرض غير متسقة، لا يمكن تنفيذ الإجراء', 409);
			await tx.projectProposal.update({ where: { id: offer.id }, data: { status: ProposalStatus.SUBMITTED } });
			if (mirrors.length) await tx.proposal.updateMany({ where: { id: { in: mirrors.map((m) => m.id) } }, data: { status: ProposalStatus.SUBMITTED } });
			await tx.message.create({
				data: { conversationId, senderId: userId, type: 'TEXT', status: 'SENT', content: buildClientDeclineEntry({ offerId: offer.id, counterMessageId: pending.messageId }) }
			});
			await tx.notification.create({
				data: {
					userId: offer.providerId,
					title: 'رفض العميل عرضك المضاد',
					message: `رفض العميل عرضك المضاد على "${request.title}"، ويبقى عرضك بشروطه الأصلية.`,
					type: 'OFFER_COUNTER_DECLINED',
					category: 'OFFERS',
					actionUrl: `/provider-overview/offers/${offer.id}/negotiate`,
					metadata: { projectId: requestId, offerId: offer.id, messageId: pending.messageId }
				}
			});
		});
		return { offerId: offer.id, status: ProposalStatus.SUBMITTED };
	}
}

export const clientOfferCounterService = new ClientOfferCounterService();
