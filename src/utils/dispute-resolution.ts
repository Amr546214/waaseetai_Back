/**
 * Dispute resolution vocabulary, shared by the DTOs, the service and the notifications.
 *
 *  - TEXT closure codes: a decision with NO financial effect. Recorded and notified only.
 *  - FINANCIAL outcomes: executed only by the dedicated financial endpoint (explicit amounts, confirmation, audit). The code string
 *    alone, typed as a closure text, does nothing and is refused there.
 *
 * Whatever free text an admin writes is kept verbatim; only an EXACT code is replaced by its Arabic label when shown to users.
 */
export const TEXT_CLOSURE_LABELS_AR: Record<string, string> = {
  MUTUAL_CLOSE: 'إغلاق ودّي باتفاق الطرفين دون أي تغيير مالي',
  NO_FINANCIAL_CHANGE: 'إغلاق النزاع دون أي تغيير مالي',
  REJECTED_INSUFFICIENT_EVIDENCE: 'رفض النزاع لعدم كفاية الأدلة'
};

export const FINANCIAL_OUTCOME_LABELS_AR = {
  REFUND_CLIENT: 'استرداد المبلغ المحتجز للعميل',
  RELEASE_PROVIDER: 'صرف المبلغ المحتجز لمقدم الخدمة',
  SPLIT: 'تقسيم المبلغ المحتجز بين الطرفين'
} as const;

export type FinancialOutcome = keyof typeof FINANCIAL_OUTCOME_LABELS_AR;
export const FINANCIAL_OUTCOMES = Object.keys(FINANCIAL_OUTCOME_LABELS_AR) as FinancialOutcome[];

/** Older codes the admin screen used to send as plain text. They never moved money; they are only labelled when read back. */
const LEGACY_CODE_LABELS_AR: Record<string, string> = {
  RELEASE_TO_PROVIDER: 'قرار إداري بصرف المبلغ لمقدم الخدمة (لم يُنفَّذ ماليًا آليًا)',
  PARTIAL_REFUND: 'قرار إداري باسترداد جزئي (لم يُنفَّذ ماليًا آليًا)'
};

export const normalizeResolutionCode = (value: string | null | undefined): string => String(value ?? '').trim().toUpperCase().replace(/[\s-]+/g, '_');

/** True when the text, on its own, is one of the financial codes (including the legacy spellings). */
export const isFinancialCode = (value: string | null | undefined): boolean => {
  const code = normalizeResolutionCode(value);
  return code in FINANCIAL_OUTCOME_LABELS_AR || code in LEGACY_CODE_LABELS_AR;
};

/**
 * The text users see for a stored `Dispute.resolution`: the Arabic label for an exact code, the original text verbatim otherwise.
 * `executedFinancially` says whether a financial outcome was actually executed for that dispute; a financial code that was NOT executed
 * (legacy rows) is labelled as an administrative statement, never as if money had moved.
 */
export function resolutionLabelAr(resolution: string | null | undefined, executedFinancially = false): string {
  const raw = String(resolution ?? '').trim();
  if (!raw) return '';
  const code = normalizeResolutionCode(raw);
  if (code in TEXT_CLOSURE_LABELS_AR) return TEXT_CLOSURE_LABELS_AR[code];
  if (code in FINANCIAL_OUTCOME_LABELS_AR) {
    const label = FINANCIAL_OUTCOME_LABELS_AR[code as FinancialOutcome];
    return executedFinancially ? label : `${label} (قرار إداري لم يُنفَّذ ماليًا)`;
  }
  if (code in LEGACY_CODE_LABELS_AR) return LEGACY_CODE_LABELS_AR[code];
  return raw;
}

export interface FinancialOutcomeSummary {
  outcome: FinancialOutcome;
  refundToClient: number;
  releaseToProvider: number;
  platformCommission: number;
  providerNet: number;
}
