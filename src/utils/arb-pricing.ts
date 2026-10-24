import { Prisma } from '@prisma/client';

/**
 * How a card deposit is priced. Pure and explicit; NOTHING here is a policy decision:
 *  - `feePercent` and `sarPerUsd` are INPUTS that only an approved policy may supply (no defaults anywhere).
 *  - gross  = net / (1 - fee%/100), rounded HALF-UP to 2 decimals (the same formula the internal finance sheet uses for deposits)
 *  - fee    = gross - net (so net + fee = gross exactly, in cents)
 *  - charge = gross x sarPerUsd, rounded HALF-UP to 2 decimals = the amount sent to the bank in SAR (the guide's amt has 2 decimals)
 *  - no VAT, no extra rounding, no conversion margin.
 * Decimal arithmetic only (never floating point equality). Worked example (fixture inputs, NOT approved numbers): net 100, fee 2.5 %, rate 3.75
 *  -> gross 102.56 (100/0.975 = 102.5641…), fee 2.56, charge 102.56 x 3.75 = 384.60 SAR.
 */
export interface ArbPrice { net: Prisma.Decimal; fee: Prisma.Decimal; gross: Prisma.Decimal; chargeSar: Prisma.Decimal }

const HALF_UP = Prisma.Decimal.ROUND_HALF_UP;

export function priceArbDeposit(netUsd: number | string, feePercent: number, sarPerUsd: number): ArbPrice {
	if (!(feePercent >= 0 && feePercent < 50)) throw new RangeError('fee percent not in an acceptable range');
	if (!(sarPerUsd > 0)) throw new RangeError('rate must be positive');
	const net = new Prisma.Decimal(netUsd).toDecimalPlaces(2, HALF_UP);
	const gross = net.div(new Prisma.Decimal(1).minus(new Prisma.Decimal(feePercent).div(100))).toDecimalPlaces(2, HALF_UP);
	return { net, fee: gross.minus(net), gross, chargeSar: gross.mul(new Prisma.Decimal(sarPerUsd)).toDecimalPlaces(2, HALF_UP) };
}
