// Single money serializer for API output. Stored values and business math (commission rounding, stage splits) are NOT touched: this only removes float-arithmetic
// noise (8.729999999999999 -> 8.73) at the output boundary, so every amount a response carries has at most 2 decimals.
export const round2 = (n: number): number => {
	const v = Number(n);
	return Number.isFinite(v) ? Math.round((v + Math.sign(v) * Number.EPSILON) * 100) / 100 : 0;
};
export const sumMoney = (values: Iterable<number>): number => {
	let total = 0;
	for (const v of values) total += Number(v) || 0;
	return round2(total);
};
