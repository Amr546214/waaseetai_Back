import { ProjectStageStatus } from '@prisma/client';

/**
 * Case 2: which stage of a running contract can carry a dispute. A stage that is not started (PENDING) has nothing to dispute yet, and an APPROVED stage's
 * money is already released (a dispute never reverses released money). Everything else is open to a dispute. Opening one changes no money: the derived
 * project freeze (dispute-freeze.service.ts) holds approvals and releases until the admin decides.
 */
export const DISPUTABLE_STAGE_STATUSES: ProjectStageStatus[] = [ProjectStageStatus.IN_PROGRESS, ProjectStageStatus.SUBMITTED, ProjectStageStatus.REVISION_REQUESTED];

/** null when the stage may carry a dispute, otherwise the Arabic reason it may not. */
export function stageDisputeBlockedReason(status: ProjectStageStatus): string | null {
  if (DISPUTABLE_STAGE_STATUSES.includes(status)) return null;
  return status === ProjectStageStatus.APPROVED ? 'هذه المرحلة اعتُمدت وصُرفت دفعتها، ولا يُفتح عليها نزاع' : 'هذه المرحلة لم تبدأ بعد، ولا يُفتح عليها نزاع';
}

/** A dispute about a stage needs a full explanation (the modal shows the counter): the server enforces the same minimum. */
export const STAGE_DISPUTE_MIN_DESCRIPTION = 100;

/** What the opener asks for. A request only: the admin decides, and nothing here moves money. */
export const REQUESTED_RESOLUTIONS = {
  REDELIVER_WITH_FIXES: 'إعادة التسليم بالتعديلات المطلوبة',
  PARTIAL_REFUND: 'استرداد جزئي من الضمان',
  FULL_REFUND: 'استرداد كامل للمرحلة',
  ACCEPT_DELIVERY: 'اعتماد التسليم وصرف المرحلة',
  EXTEND_DEADLINE: 'تمديد مدة المرحلة',
  CLARIFY_SCOPE: 'توضيح نطاق العمل المتفق عليه',
  OTHER: 'حل آخر تقترحه الإدارة'
} as const;
export type RequestedResolutionCode = keyof typeof REQUESTED_RESOLUTIONS;
export const requestedResolutionLabel = (code: string | null | undefined) => (code && code in REQUESTED_RESOLUTIONS ? REQUESTED_RESOLUTIONS[code as RequestedResolutionCode] : null);
