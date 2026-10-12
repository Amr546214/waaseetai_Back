// Structured negotiation messages (`WS_NEGOTIATION::{json}` in a project conversation) — the ONLY source of negotiation state; there is no table.
// The client's card is written by chat.service (free-typed strings, no ids). The provider's own entries (counter / reply) are written by
// provider-offer-negotiation.service with `kind` + `offerId`. Nothing here trusts free text: a number is only accepted when the whole string is a plain number.

export const NEG_PREFIX = 'WS_NEGOTIATION::';

export type NegotiationKind = 'CLIENT_REQUEST' | 'PROVIDER_COUNTER' | 'PROVIDER_REJECT';

export interface ParsedNegotiation {
	kind: NegotiationKind;
	/** Plain-number readings (null when the text is not a clear number). */
	price: number | null;
	deliveryDays: number | null;
	notes: string;
	/** Provider entries only. */
	offerId: string | null;
	replyToMessageId: string | null;
}

export interface NegotiationMessageRow {
	id: string;
	senderId: string;
	content: string | null;
	createdAt: Date;
}

export const MAX_OFFER_PRICE = 10_000_000;
export const MAX_OFFER_DAYS = 3650;
export const MAX_COUNTER_NOTE = 500;

/** "4000", "4,000", "4000.50", "4000 $" -> number; anything else ("حوالي 4000", "3000-4000", "") -> null. */
export function readPlainNumber(value: unknown): number | null {
	if (typeof value === 'number') return Number.isFinite(value) && value > 0 ? value : null;
	if (typeof value !== 'string') return null;
	const cleaned = value.replace(/[\s$]|دولار|يوم|أيام|ايام/g, '').replace(/,/g, '');
	if (!/^\d+(\.\d{1,2})?$/.test(cleaned)) return null;
	const n = Number(cleaned);
	return Number.isFinite(n) && n > 0 ? n : null;
}

const asText = (v: unknown, max: number) => (typeof v === 'string' ? v.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max) : '');

/** Parses one message; null when it is not a WS_NEGOTIATION message or its JSON is unreadable. `senderIsProvider` decides which kinds are believable. */
export function parseNegotiationMessage(content: string | null | undefined, senderIsProvider: boolean): ParsedNegotiation | null {
	if (!content || !content.startsWith(NEG_PREFIX)) return null;
	let raw: unknown;
	try {
		raw = JSON.parse(content.slice(NEG_PREFIX.length));
	} catch {
		return null;
	}
	if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
	const o = raw as Record<string, unknown>;
	let kind: NegotiationKind = 'CLIENT_REQUEST';
	if (senderIsProvider) {
		if (o.kind === 'PROVIDER_COUNTER' || o.kind === 'PROVIDER_REJECT') kind = o.kind;
		else return null; // a provider's free-form WS_NEGOTIATION text is not a state-bearing entry
	}
	return {
		kind,
		price: readPlainNumber(o.priceValue ?? o.price),
		deliveryDays: readPlainNumber(o.deliveryDays ?? o.duration),
		notes: asText(o.notes, 1000),
		offerId: typeof o.offerId === 'string' ? o.offerId : null,
		replyToMessageId: typeof o.replyToMessageId === 'string' ? o.replyToMessageId : null
	};
}

/** A client request is "clear" only when it carries a readable price and/or duration. Anything else is free-text and never acted on automatically. */
export const isClearRequest = (p: ParsedNegotiation) => p.kind === 'CLIENT_REQUEST' && (p.price !== null || p.deliveryDays !== null);

export interface NegotiationEntry extends ParsedNegotiation {
	messageId: string;
	createdAt: Date;
}

/** Newest first. Messages from the client count only as CLIENT_REQUEST; from the provider only the structured kinds written by this module. */
export function readNegotiationEntries(rows: NegotiationMessageRow[], providerId: string): NegotiationEntry[] {
	const out: NegotiationEntry[] = [];
	for (const row of rows) {
		const parsed = parseNegotiationMessage(row.content, row.senderId === providerId);
		if (parsed) out.push({ ...parsed, messageId: row.id, createdAt: row.createdAt });
	}
	return out.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
}

export interface NegotiationState {
	/** The newest state-bearing entry decides: a counter is pending when it is the newest entry. */
	counterPending: boolean;
	/** The newest client request, only while it is also the newest entry (nothing answered it yet). */
	openRequest: NegotiationEntry | null;
}

export function deriveNegotiationState(entriesNewestFirst: NegotiationEntry[], offerId: string): NegotiationState {
	const relevant = entriesNewestFirst.filter((e) => e.kind === 'CLIENT_REQUEST' || e.offerId === offerId);
	const newest = relevant[0] || null;
	return {
		counterPending: !!newest && newest.kind === 'PROVIDER_COUNTER',
		openRequest: newest && newest.kind === 'CLIENT_REQUEST' ? newest : null
	};
}

export function buildProviderEntry(kind: 'PROVIDER_COUNTER' | 'PROVIDER_REJECT', input: { offerId: string; price?: number; deliveryDays?: number; notes?: string; replyToMessageId?: string }): string {
	const isCounter = kind === 'PROVIDER_COUNTER';
	return NEG_PREFIX + JSON.stringify({
		isNegotiation: true,
		schema: 2,
		kind,
		offerId: input.offerId,
		negType: isCounter ? 'counter' : 'reply',
		negTypeName: isCounter ? 'عرض مضاد من مقدم الخدمة' : 'رد مقدم الخدمة على طلب التفاوض',
		// legacy card fields: the card renders price/notes as text; `status` is never PENDING so no local accept/reject buttons are drawn on the other side
		price: input.price !== undefined ? String(input.price) : '',
		priceValue: input.price,
		deliveryDays: input.deliveryDays,
		duration: input.deliveryDays !== undefined ? `${input.deliveryDays} يوم` : '',
		notes: input.notes || '',
		replyToMessageId: input.replyToMessageId,
		status: isCounter ? 'COUNTER_SENT' : 'REJECTED'
	});
}
