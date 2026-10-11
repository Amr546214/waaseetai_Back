// ONE answer to "where does this specialty stand?": the test (isPassed), the samples and the admin decision are three different things and are never mixed.
//   test passed        -> ProviderSpecialty.isPassed (a fact about the quiz / setup test, NOT an approval)
//   samples submitted  -> AccreditationSample rows (the only thing the admin queue lists) ; WorkSample rows are the wizard's drafts and sit in no queue
//   approved           -> ProviderSpecialty.status === 'APPROVED' (written only by an admin decision)
export type SpecialtyApprovalState =
  | 'APPROVED' | 'LOCKED' | 'TEST_NOT_TAKEN' | 'TEST_NOT_PASSED' | 'REJECTED'
  | 'PASSED_NO_SAMPLES' | 'DRAFT_SAMPLES' | 'SAMPLES_UNDER_REVIEW' | 'SAMPLES_REJECTED';

export interface SampleLite { status: string; aiFeedbackAr?: string | null; createdAt: Date | string }

const REASON_MARK = '[مراجعة الإدارة] سبب الرفض:';

/** The admin's reason, taken from the rejected sample (the backend appends it to aiFeedbackAr under this marker). */
export function extractRejectionReason(feedback: string | null | undefined): string | null {
  const text = String(feedback ?? '');
  const i = text.lastIndexOf(REASON_MARK);
  if (i < 0) return null;
  const reason = text.slice(i + REASON_MARK.length).trim();
  return reason || null;
}

export function deriveApprovalState(input: { status: string; isPassed: boolean; hasTakenAssessment: boolean; workSampleCount: number; samples: SampleLite[] }) {
  const samples = [...input.samples].sort((a, b) => +new Date(b.createdAt) - +new Date(a.createdAt));
  const pending = samples.filter(s => s.status === 'MANUAL_REVIEW' || s.status === 'PENDING_AI_AUDIT').length;
  const rejectedSamples = samples.filter(s => s.status === 'REJECTED');
  const counts = { total: samples.length, pending, rejected: rejectedSamples.length, approved: samples.filter(s => s.status === 'AI_VERIFIED').length };
  const base = { workSampleCount: input.workSampleCount, accreditationSamples: counts, rejectionReason: null as string | null };

  let state: SpecialtyApprovalState;
  if (input.status === 'APPROVED') state = 'APPROVED';
  else if (input.status === 'LOCKED_OUT') state = 'LOCKED';
  else if (!input.isPassed) state = input.status === 'REJECTED' ? 'REJECTED' : input.hasTakenAssessment ? 'TEST_NOT_PASSED' : 'TEST_NOT_TAKEN';
  else if (pending > 0 || counts.approved > 0) state = 'SAMPLES_UNDER_REVIEW';
  else if (input.status === 'REJECTED' || samples[0]?.status === 'REJECTED') state = 'SAMPLES_REJECTED';
  else if (input.workSampleCount > 0) state = 'DRAFT_SAMPLES';
  else state = 'PASSED_NO_SAMPLES';

  if (state === 'SAMPLES_REJECTED') base.rejectionReason = extractRejectionReason(rejectedSamples[0]?.aiFeedbackAr);
  return { approvalState: state, ...base };
}
