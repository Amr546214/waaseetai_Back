import { publicKycRejectionReason } from './provider-kyc-review';
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
  /** ProviderProfile.kycStatus: the admin's KYC queue (separate from the DOCUMENTS request). */
  kycStatus?: string | null;
  /** ProviderProfile.notes (internal): only the admin's "سبب الرفض:" text is ever shown, through publicKycRejectionReason. */
  kycNotes?: unknown;
}): IdentityVerification {
  const r = input.latestDocumentRequest;
  // ONE rule for every page (the profile data page and the dashboard badge both use it):
  //  1. a document request waiting for the admin           -> PENDING_REVIEW (a new submission overrides an old refusal)
  //  2. the admin's KYC review refused the identity         -> REJECTED (safe reason)
  //  3. an approved document is stored / KYC is VERIFIED    -> VERIFIED (a stale KYC "PENDING" never contradicts an approved document)
  //  4. the last document request was rejected              -> REJECTED
  //  5. identity documents sent in the setup wizard wait in the KYC queue -> PENDING_REVIEW
  //  6. otherwise                                           -> NOT_SUBMITTED
  if (input.pendingDocumentReview) return { status: 'PENDING_REVIEW', requestId: r?.id ?? null, submittedAt: r?.createdAt?.toISOString() ?? null, rejectionReason: null };
  const kycRejection = publicKycRejectionReason(input.kycStatus, input.kycNotes);
  if (kycRejection) return { status: 'REJECTED', requestId: null, submittedAt: null, rejectionReason: kycRejection };
  if (input.storedIdDocument || input.kycStatus === 'VERIFIED') return { status: 'VERIFIED', requestId: null, submittedAt: null, rejectionReason: null };
  if (r?.status === 'REJECTED') return { status: 'REJECTED', requestId: r.id, submittedAt: r.createdAt.toISOString(), rejectionReason: r.rejectionReason ?? null };
  if (input.kycStatus === 'PENDING') return { status: 'PENDING_REVIEW', requestId: null, submittedAt: null, rejectionReason: null };
  return { status: 'NOT_SUBMITTED', requestId: null, submittedAt: null, rejectionReason: null };
}
