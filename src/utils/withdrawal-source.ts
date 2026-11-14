import { AccountType, Prisma, UserRole, WithdrawalSource } from '@prisma/client';

/**
 * A user may hold BOTH the provider role and the marketer (affiliate) role. Each role has its OWN money: the provider's released earnings and the marketer's approved commissions.
 * Every withdrawal says which ledger it was made against (`Withdrawal.source`); a balance is only ever reduced by the withdrawals of ITS ledger.
 * A row created before that column existed (source NULL) keeps its historical meaning: provider ledger for a user with a provider identity, marketer ledger otherwise.
 */
export type WithdrawalOwner = { accountType: AccountType; roles: UserRole[] | null; activeRole: UserRole | null };

export function isProviderOwner(user: WithdrawalOwner): boolean {
	return user.accountType === AccountType.PROVIDER_INDIVIDUAL
		|| user.accountType === AccountType.PROVIDER_COMPANY
		|| (user.roles ?? []).includes(UserRole.PROVIDER)
		|| user.activeRole === UserRole.PROVIDER;
}

/** the ledger of one withdrawal row */
export const sourceOfWithdrawal = (row: { source?: WithdrawalSource | null }, owner: WithdrawalOwner): WithdrawalSource =>
	row.source ?? (isProviderOwner(owner) ? WithdrawalSource.PROVIDER : WithdrawalSource.MARKETER);

/** a Prisma `where` fragment selecting the withdrawals of ONE ledger of a user (legacy NULL rows follow the historical rule above). Spread it into a `where` that has no `OR` of its own. */
export function withdrawalSourceWhere(source: WithdrawalSource, ownerIsProvider: boolean): Prisma.WithdrawalWhereInput {
	const legacyBelongsHere = source === WithdrawalSource.PROVIDER ? ownerIsProvider : !ownerIsProvider;
	return legacyBelongsHere ? { OR: [{ source }, { source: null }] } : { source };
}
