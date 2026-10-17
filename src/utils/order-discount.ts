// A provider coupon discounts the SERVICE VALUE itself (not the platform): what the client pays is the contract price, the escrow and the stage amounts, and the
// platform commission / provider release are computed on that net value. The order stores one `discount`; this spreads it back over the order's items.

export const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;

export interface DiscountItem { id: string; serviceId: string | null; price: number }
export interface DiscountScope { serviceIds: string[]; excludedServiceIds: string[] }

/** itemId -> discount share. Same eligibility rule the coupon was priced with (coupon services, minus excluded; no services = all). Sum of shares = discount exactly. */
export function allocateOrderDiscount(items: DiscountItem[], discount: number, scope: DiscountScope | null): Map<string, number> {
	const out = new Map<string, number>(items.map(i => [i.id, 0]));
	const total = round2(Number(discount) || 0);
	if (total <= 0 || items.length === 0) return out;
	const inScope = (i: DiscountItem) => {
		if (!scope) return true;
		if (i.serviceId && scope.excludedServiceIds.includes(i.serviceId)) return false;
		return scope.serviceIds.length === 0 || (!!i.serviceId && scope.serviceIds.includes(i.serviceId));
	};
	let eligible = items.filter(inScope);
	if (eligible.length === 0) eligible = items; // an inconsistent scope never loses the discount: spread over the whole order
	const base = round2(eligible.reduce((s, i) => s + i.price, 0));
	if (base <= 0) return out;
	const capped = Math.min(total, base);
	let left = capped;
	eligible.forEach((item, index) => {
		const share = index === eligible.length - 1 ? left : Math.min(round2(capped * item.price / base), left);
		out.set(item.id, round2(share));
		left = round2(left - share);
	});
	return out;
}

/** Splits `total` over `weights` (e.g. the service's stage amounts) so the parts sum EXACTLY to `total` (last part takes the rounding remainder). Equal weights if all 0. */
export function splitByWeights(weights: number[], total: number): number[] {
	if (weights.length === 0) return [];
	const sum = weights.reduce((s, w) => s + w, 0);
	if (round2(sum) === round2(total)) return weights.map(round2); // no discount: stage amounts stay exactly as published
	const parts: number[] = [];
	let left = round2(total);
	weights.forEach((w, index) => {
		const share = index === weights.length - 1 ? left : round2(sum > 0 ? total * w / sum : total / weights.length);
		parts.push(share);
		left = round2(left - share);
	});
	return parts;
}
