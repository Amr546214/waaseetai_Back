// Provider identity (KYC) review as the provider may see it. ProviderProfile.notes holds the admin's rejection text ("سبب الرفض: …") and, from the
// setup wizard, free text: the raw column is never returned to the user. Only the rejection reason an admin typed for the provider is exposed,
// and only while the review is REJECTED; with none, a generic message.
export const PROVIDER_KYC_REJECTION_PREFIX = 'سبب الرفض:';
export const PROVIDER_KYC_GENERIC_REJECTION = 'تم رفض المستندات. يرجى رفع مستندات أوضح أو التواصل مع الدعم.';

/** null unless the review is REJECTED; otherwise the admin's reason, or the generic message when there is none. */
export function publicKycRejectionReason(kycStatus: string | null | undefined, notes: unknown): string | null {
  if (kycStatus !== 'REJECTED') return null;
  const text = typeof notes === 'string' ? notes.trim() : '';
  if (text.startsWith(PROVIDER_KYC_REJECTION_PREFIX)) {
    const reason = text.slice(PROVIDER_KYC_REJECTION_PREFIX.length).trim().slice(0, 500);
    if (reason) return reason;
  }
  return PROVIDER_KYC_GENERIC_REJECTION;
}

/** The same row without the internal `notes` column. */
export function withoutInternalProviderNotes<T extends Record<string, any> | null | undefined>(row: T): T {
  if (!row) return row;
  const { notes: _notes, ...rest } = row as Record<string, any>;
  return rest as T;
}
