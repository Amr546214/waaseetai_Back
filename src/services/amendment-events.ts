import { appendProjectEvent } from './project-conversation.service';
import { effectiveParts } from './amendment-apply.service';

/**
 * Truthful project events for the amendment lifecycle (spec §11). Each state change writes ONE project event (a SYSTEM message of the project room)
 * AFTER the state change is committed, keyed deterministically (`amendment:<id>:<kind>`) so a retried request / socket echo creates nothing twice.
 * "applied" is emitted only from a row whose appliedAt is set by the applying transaction. No OTP / code / token ever enters a text: only the party,
 * the days, the amounts and the request title.
 */
export type AmendmentEventKind = 'created' | 'accepted' | 'rejected' | 'cancelled' | 'funding_authorised' | 'applied';

type Row = {
	id: string; contractId: string; projectId: string; requestedByRole: string; title: string; type: string; description?: string | null;
	budgetDelta?: number | null; durationDeltaDays?: number | null; appliedAt?: Date | null;
	priceBefore?: number | null; priceAfter?: number | null; durationBefore?: number | null; durationAfter?: number | null;
	fundingAuthorizedAt?: Date | null; fundingAuthorizedAmount?: number | null;
};

const num = (n: number) => (Math.round(n * 100) / 100).toLocaleString('en-US', { maximumFractionDigits: 2 });
const partyOf = (role: string) => (role === 'CLIENT' ? 'العميل' : 'مقدم الخدمة');
const otherOf = (role: string) => (role === 'CLIENT' ? 'مقدم الخدمة' : 'العميل');
const quoted = (title: string) => `«${title.length > 80 ? `${title.slice(0, 80)}…` : title}»`;

/** «تعديل المدة من 4 إلى 6 أيام» / «تعديل الميزانية من 200 إلى 250 $» / «تعديل النطاق», from the contract state the request was raised against. */
function requestParts(row: Row, contract: { price: number; durationDays: number }): string {
	const { budget, days, addendum } = effectiveParts({ type: row.type, budgetDelta: row.budgetDelta ?? null, durationDeltaDays: row.durationDeltaDays ?? null, description: row.description ?? null });
	const parts: string[] = [];
	if (days !== 0) parts.push(`المدة من ${contract.durationDays} إلى ${contract.durationDays + days} أيام`);
	if (budget !== 0) parts.push(`الميزانية من ${num(contract.price)} إلى ${num(contract.price + budget)} $`);
	if (addendum) parts.push('النطاق');
	return parts.length ? `تعديل ${parts.join(' و')}` : 'تعديل';
}

function appliedParts(row: Row): string {
	const parts: string[] = [];
	if (row.durationBefore != null && row.durationAfter != null && row.durationBefore !== row.durationAfter) parts.push(`المدة من ${row.durationBefore} إلى ${row.durationAfter} أيام`);
	if (row.priceBefore != null && row.priceAfter != null && Math.abs(row.priceBefore - row.priceAfter) > 0.005) parts.push(`الميزانية من ${num(row.priceBefore)} إلى ${num(row.priceAfter)} $`);
	if (effectiveParts({ type: row.type, budgetDelta: row.budgetDelta ?? null, durationDeltaDays: row.durationDeltaDays ?? null, description: row.description ?? null }).addendum) parts.push('النطاق');
	return parts.join(' و');
}

export function amendmentEventText(kind: AmendmentEventKind, row: Row, contract?: { price: number; durationDays: number }): string | null {
	const title = quoted(row.title);
	switch (kind) {
		case 'created': return contract ? `طلب ${partyOf(row.requestedByRole)} ${requestParts(row, contract)} — ${title}` : `طلب ${partyOf(row.requestedByRole)} تعديلًا على العقد — ${title}`;
		case 'accepted': return `وافق ${otherOf(row.requestedByRole)} على طلب التعديل ${title}`;
		case 'rejected': return `رفض ${otherOf(row.requestedByRole)} طلب التعديل ${title}`;
		case 'cancelled': return `ألغى ${partyOf(row.requestedByRole)} طلب التعديل ${title}`;
		case 'funding_authorised': return row.fundingAuthorizedAmount != null ? `اعتمد العميل دفع زيادة الميزانية (${num(row.fundingAuthorizedAmount)} $) لطلب التعديل ${title}` : `اعتمد العميل دفع زيادة الميزانية لطلب التعديل ${title}`;
		// Never says "applied" for a row the transaction did not apply.
		case 'applied': return row.appliedAt ? `طُبّق التعديل على العقد${appliedParts(row) ? `: ${appliedParts(row)}` : ''} — ${title}` : null;
	}
}

export const amendmentEventKey = (kind: AmendmentEventKind, row: Row): string =>
	kind === 'funding_authorised' && row.fundingAuthorizedAt ? `amendment:${row.id}:funding_authorised:${new Date(row.fundingAuthorizedAt).getTime()}` : `amendment:${row.id}:${kind}`;

/** Records the event; never throws and never blocks the business action (appendProjectEvent swallows and logs). */
export async function emitAmendmentEvent(kind: AmendmentEventKind, row: Row, actorId: string, contract?: { price: number; durationDays: number }, notBefore?: Date) {
	const text = amendmentEventText(kind, row, contract);
	if (!text) return { created: false };
	return appendProjectEvent({
		contractId: row.contractId, eventKey: amendmentEventKey(kind, row), actorId, text, event: `AMENDMENT_${kind.toUpperCase()}`, notBefore,
		meta: { amendmentId: row.id, amendmentStatusEvent: kind }
	});
}
