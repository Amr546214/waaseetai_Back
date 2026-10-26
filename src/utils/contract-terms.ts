// Safe reading of Contract.terms (a Json column: the snapshot taken when the client selects the offer). Its shape is NOT guaranteed — legacy offers,
import { commissionOn } from './escrow-commission';
// manual rows or future versions may store null, a string, an array, or an object with missing/odd fields — so this never throws and never invents data:
// whatever cannot be read is simply absent (null / empty list).
export interface ContractMilestoneView {
	order: number;
	title: string;
	description: string | null;
	days: number | null;
	percentage: number | null;
	amount: number | null;
}

export interface ProviderContractView {
	id: string;
	status: string;
	termsVersion: number;
	price: number;
	/** the contract's own currency */
	currency: string;
	durationDays: number;
	phasesCount: number;
	/** Only what the saved terms really contain ([] when they hold no milestones). */
	milestones: ContractMilestoneView[];
	/** The funded escrow of the project, or null. */
	escrow: { amount: number; status: string } | null;
	/** The provider's FINAL terms once the client has funded: the commission rate frozen on the escrow and what it leaves the provider. Null before funding (nothing is frozen yet; see the fee preview). */
	providerTerms: { ratePercent: number; commission: number; net: number; final: true } | null;
}

const MAX_MILESTONES = 20;
const text = (v: unknown, max: number) => (typeof v === 'string' ? v.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max) : '');
const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null);

function asObject(terms: unknown): Record<string, unknown> | null {
	let value = terms;
	if (typeof value === 'string') {
		try {
			value = JSON.parse(value);
		} catch {
			return null;
		}
	}
	return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

/** The milestones saved in the terms snapshot, in order. Entries without a readable title are dropped. */
export function parseContractMilestones(terms: unknown): ContractMilestoneView[] {
	const obj = asObject(terms);
	const raw = obj && Array.isArray(obj.milestones) ? obj.milestones : [];
	const out: ContractMilestoneView[] = [];
	for (const [index, item] of raw.entries()) {
		if (!item || typeof item !== 'object') continue;
		const m = item as Record<string, unknown>;
		const title = text(m.title, 120);
		if (!title) continue;
		const pct = num(m.percentage);
		out.push({
			order: typeof m.stepOrder === 'number' && Number.isFinite(m.stepOrder) && m.stepOrder > 0 ? m.stepOrder : index + 1,
			title,
			description: text(m.description, 500) || null,
			days: num(m.days),
			percentage: pct !== null && pct <= 100 ? pct : null,
			amount: num(m.amount)
		});
		if (out.length >= MAX_MILESTONES) break;
	}
	return out.sort((a, b) => a.order - b.order);
}

/** What the provider's sign-contract page may show: the contract's own values, the milestones of its saved terms, and its funded escrow. */
export function buildProviderContractView(
	contract: { id: string; status: string; termsVersion: number; price: number; currency?: string | null; durationDays: number; phasesCount: number; terms: unknown },
	escrow: { amount: number; status: string; providerCommissionRateSnapshot?: number | null; feePolicyVersion?: number | null } | null | undefined
): ProviderContractView {
	return {
		id: contract.id,
		status: contract.status,
		termsVersion: contract.termsVersion,
		price: contract.price,
		currency: contract.currency ?? 'USD',
		durationDays: contract.durationDays,
		phasesCount: contract.phasesCount,
		milestones: parseContractMilestones(contract.terms),
		escrow: escrow ? { amount: escrow.amount, status: escrow.status } : null,
		providerTerms: escrow && escrow.feePolicyVersion === 2 && typeof escrow.providerCommissionRateSnapshot === 'number'
			? (() => { const commission = commissionOn(contract.price, escrow.providerCommissionRateSnapshot!); return { ratePercent: escrow.providerCommissionRateSnapshot!, commission, net: Math.round((contract.price - commission) * 100) / 100, final: true as const }; })()
			: null
	};
}
