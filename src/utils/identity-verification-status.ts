// Where a provider's identity document stands, as the profile page must say it (and keep saying it after a refresh):
//  PENDING_REVIEW  a DOCUMENTS request was confirmed by the e-mailed code and is waiting for the admin
//  VERIFIED        the document is stored on the account (an admin approval applies it)
//  REJECTED        the last request was rejected and nothing is stored (with the admin's reason)
//  NOT_SUBMITTED   nothing was sent
export type IdentityVerificationStatus = 'PENDING_REVIEW' | 'VERIFIED' | 'REJECTED' | 'NOT_SUBMITTED';
export interface IdentityVerification { status: IdentityVerificationStatus; requestId: string | null; submittedAt: string | null; rejectionReason: string | null }

export function deriveIdentityVerification(input: {
  pendingDocumentReview: boolean;
  storedIdDocument: boolean;
  latestDocumentRequest: { id: string; status: string; createdAt: Date; rejectionReason: string | null } | null;
}): IdentityVerification {
  const r = input.latestDocumentRequest;
  if (input.pendingDocumentReview) return { status: 'PENDING_REVIEW', requestId: r?.id ?? null, submittedAt: r?.createdAt?.toISOString() ?? null, rejectionReason: null };
  if (input.storedIdDocument) return { status: 'VERIFIED', requestId: null, submittedAt: null, rejectionReason: null };
  if (r?.status === 'REJECTED') return { status: 'REJECTED', requestId: r.id, submittedAt: r.createdAt.toISOString(), rejectionReason: r.rejectionReason ?? null };
  return { status: 'NOT_SUBMITTED', requestId: null, submittedAt: null, rejectionReason: null };
}
