// Where a provider's identity document stands, as the profile page must say it (and keep saying it after a refresh):
//  PENDING_REVIEW  a DOCUMENTS request was confirmed by the e-mailed code and is waiting for the admin
//  VERIFIED        the document is stored on the account (an admin approval applies it)
//  REJECTED        the last request was rejected and nothing is stored, or the admin's KYC review refused the identity (with the reason)
//  NOT_SUBMITTED   nothing was sent
export type IdentityVerificationStatus = 'PENDING_REVIEW' | 'VERIFIED' | 'REJECTED' | 'NOT_SUBMITTED';
export interface IdentityVerification { status: IdentityVerificationStatus; requestId: string | null; submittedAt: string | null; rejectionReason: string | null }

export function deriveIdentityVerification(input: {
  pendingDocumentReview: boolean;
  storedIdDocument: boolean;
  latestDocumentRequest: { id: string; status: string; createdAt: Date; rejectionReason: string | null } | null;
  /** the admin's KYC review (a separate queue from the DOCUMENTS request) refused the identity: the safe reason to show. A new waiting request overrides it. */
  kycRejection?: string | null;
}): IdentityVerification {
  const r = input.latestDocumentRequest;
  if (input.pendingDocumentReview) return { status: 'PENDING_REVIEW', requestId: r?.id ?? null, submittedAt: r?.createdAt?.toISOString() ?? null, rejectionReason: null };
  if (input.kycRejection) return { status: 'REJECTED', requestId: null, submittedAt: null, rejectionReason: input.kycRejection };
  if (input.storedIdDocument) return { status: 'VERIFIED', requestId: null, submittedAt: null, rejectionReason: null };
  if (r?.status === 'REJECTED') return { status: 'REJECTED', requestId: r.id, submittedAt: r.createdAt.toISOString(), rejectionReason: r.rejectionReason ?? null };
  return { status: 'NOT_SUBMITTED', requestId: null, submittedAt: null, rejectionReason: null };
}
