// PayPal is the only payout destination for a provider. ProviderProfile / User still carry the legacy bank columns (iban, bankName,
// accountHolder, paymentType / ibanNumber, accountHolderName): they are never returned, shown or used (no migration, no data change).

/** The provider profile (or a user row) without the legacy bank columns; a nested `user` is cleaned too. */
export function withoutLegacyProviderBankFields<T extends Record<string, any> | null | undefined>(row: T): T {
  if (!row) return row;
  const { paymentType: _p, bankName: _b, accountHolder: _a, iban: _i, ibanNumber: _n, accountHolderName: _h, ...rest } = row as Record<string, any>;
  if (rest.user && typeof rest.user === 'object') rest.user = withoutLegacyProviderBankFields(rest.user);
  return rest as T;
}

export const PROVIDER_PAYPAL_REQUIRED_MESSAGE = 'أضف بريد PayPal لاستلام الأرباح';
