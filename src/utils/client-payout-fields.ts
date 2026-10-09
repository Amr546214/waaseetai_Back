// PayPal is the ONLY financial method on the platform. A client row may still carry legacy bank / wallet columns (paymentType, bankName,
// accountHolder, iban): they are never displayed, returned or used (no migration, no data change; the columns just stay untouched in the DB).

/** The payload keys that would carry a bank account / IBAN / account holder / wallet. */
export const NON_PAYPAL_PAYOUT_KEYS = [
  'bankName', 'accountHolder', 'accountHolderName', 'iban', 'ibanNumber', 'bankAccount', 'accountNumber',
  'wallet', 'walletProvider', 'walletPhone', 'walletId', 'walletNumber', 'ewallet'
] as const;

export const PAYPAL_ONLY_MESSAGE = 'لا تُقبل على المنصة إلا وسيلة PayPal: لا حساب بنكي ولا IBAN ولا محفظة';

/** Keys of `value` that carry a non-empty bank / wallet value. */
export function nonPaypalPayoutKeys(value: unknown): string[] {
  if (!value || typeof value !== 'object') return [];
  const v = value as Record<string, unknown>;
  return NON_PAYPAL_PAYOUT_KEYS.filter(k => v[k] !== undefined && v[k] !== null && String(v[k]).trim() !== '');
}

/** The same row without the legacy bank / wallet columns. */
export function withoutLegacyPayoutFields<T extends Record<string, any> | null | undefined>(row: T): T {
  if (!row) return row;
  const { paymentType: _p, bankName: _b, accountHolder: _a, iban: _i, ...rest } = row as Record<string, any>;
  return rest as T;
}
