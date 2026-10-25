import { Prisma } from '@prisma/client';
import { LEGACY_CURRENCY, requireCurrency } from './currency';

/**
 * Wallet balance PER CURRENCY. The legacy `users.walletBalance` column IS the USD balance (it is not renamed, not converted, not touched by any other currency); every other supported
 * currency lives in `wallet_balances(userId, currency)`. Every wallet mutation goes through here so a balance in one currency can never pay for, or be credited by, another.
 * Each function takes the transaction client and keeps the exact conditional-update semantics the callers already relied on (a debit only succeeds while the balance covers it).
 */
type Tx = Pick<Prisma.TransactionClient, 'user' | 'walletBalance'>;
const isLegacy = (c: string) => c === LEGACY_CURRENCY;

/** debits `amount` only if the balance in `currency` covers it; false = nothing moved */
export async function debitWalletIfCovered(tx: Tx, userId: string, currency: string, amount: number): Promise<boolean> {
	const cur = requireCurrency(currency);
	if (isLegacy(cur)) return (await tx.user.updateMany({ where: { id: userId, walletBalance: { gte: amount } }, data: { walletBalance: { decrement: amount } } })).count === 1;
	return (await tx.walletBalance.updateMany({ where: { userId, currency: cur, balance: { gte: amount } }, data: { balance: { decrement: amount } } })).count === 1;
}
export async function creditWallet(tx: Tx, userId: string, currency: string, amount: number): Promise<void> {
	const cur = requireCurrency(currency);
	if (isLegacy(cur)) { await tx.user.update({ where: { id: userId }, data: { walletBalance: { increment: amount } } }); return; }
	await tx.walletBalance.upsert({ where: { userId_currency: { userId, currency: cur } }, create: { userId, currency: cur, balance: amount }, update: { balance: { increment: amount } } });
}
export async function walletBalanceOf(tx: Tx, userId: string, currency: string): Promise<number> {
	const cur = requireCurrency(currency);
	if (isLegacy(cur)) return Number((await tx.user.findUnique({ where: { id: userId }, select: { walletBalance: true } }))?.walletBalance ?? 0);
	return Number((await tx.walletBalance.findUnique({ where: { userId_currency: { userId, currency: cur } }, select: { balance: true } }))?.balance ?? 0);
}
/** every balance the user holds, one per currency (the legacy USD balance is always listed) */
export async function walletBalancesOf(tx: Tx, userId: string): Promise<Record<string, number>> {
	const out: Record<string, number> = { [LEGACY_CURRENCY]: await walletBalanceOf(tx, userId, LEGACY_CURRENCY) };
	for (const r of await tx.walletBalance.findMany({ where: { userId }, select: { currency: true, balance: true } })) out[r.currency] = Number(r.balance);
	return out;
}
