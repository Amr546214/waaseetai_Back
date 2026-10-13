// Precise, server-derived delivery / revision / escrow state for a provider's contract. The frontend renders these fields as they are: it keeps no
// state rules of its own. canUploadDelivery mirrors EXACTLY the server guard in project-progress.service.assertDeliverable (contract ACTIVE and the
// stage IN_PROGRESS or REVISION_REQUESTED), so a button shown from it can never be refused by the server for state reasons.

export type DeliveryStageInput = { status: string; deliveries: Array<{ status: string }> };
export type DeliveryEscrowInput = { status: string; amount: number; releasedAmount?: number | null } | null | undefined;

export const CONTRACT_BLOCK_REASON: Record<string, string> = {
  PENDING_CLIENT_SIGNATURE: 'العقد بانتظار توقيع العميل، ولا يمكن التسليم قبل بدء العقد',
  PENDING_PROVIDER_SIGNATURE: 'العقد بانتظار توقيعك، ولا يمكن التسليم قبل بدء العقد',
  PENDING_PAYMENT: 'بانتظار إيداع العميل للضمان، ولا يمكن التسليم قبل تمويله',
  COMPLETED: 'العقد مكتمل ولا يقبل تسليمات جديدة',
  CANCELLED: 'العقد ملغى ولا يقبل تسليمات',
  DISPUTED: 'العقد قيد نزاع، والتسليم موقوف حتى حسم النزاع'
};
const STAGE_BLOCK_REASON: Record<string, string> = {
  PENDING: 'المرحلة لم تبدأ بعد، وتُفتح بعد اعتماد المرحلة السابقة',
  SUBMITTED: 'التسليم الحالي بانتظار مراجعة العميل',
  APPROVED: 'المرحلة معتمدة ولا تحتاج تسليماً'
};

/** Escrow facts. "Funded" = a HELD escrow row exists; a contract with no escrow (or a refunded / fully released one) holds nothing. */
export function escrowFacts(escrow: DeliveryEscrowInput) {
  const funded = !!escrow && escrow.status === 'HELD';
  return {
    escrowStatus: escrow ? escrow.status : null,
    escrowFunded: funded,
    heldAmount: funded ? Math.max(0, escrow!.amount - (escrow!.releasedAmount || 0)) : 0
  };
}

export function stageDeliveryState(contractStatus: string, stage: DeliveryStageInput) {
  const statuses = stage.deliveries.map(d => d.status);
  const latest = statuses[statuses.length - 1];
  const stageOpen = stage.status === 'IN_PROGRESS' || stage.status === 'REVISION_REQUESTED';
  const canSubmit = contractStatus === 'ACTIVE' && stageOpen;
  const uploadBlockedReason = canSubmit ? null : (contractStatus !== 'ACTIVE' ? (CONTRACT_BLOCK_REASON[contractStatus] || 'العقد غير نشط') : (STAGE_BLOCK_REASON[stage.status] || 'هذه المرحلة غير متاحة للتسليم حالياً'));
  return {
    canUploadDelivery: canSubmit,
    canSubmitDelivery: canSubmit,
    uploadBlockedReason,
    awaitingClientReview: stage.status === 'SUBMITTED' && latest === 'SUBMITTED',
    revisionRequested: stage.status === 'REVISION_REQUESTED',
    // A revision was asked for earlier and the provider has delivered again: the stage now waits for the client, not for the provider.
    revisionResubmitted: stage.status === 'SUBMITTED' && latest === 'SUBMITTED' && statuses.slice(0, -1).includes('REVISION_REQUESTED')
  };
}

/** Roll-up over a contract's stages (project level). No stage rows yet = nothing can be delivered. */
export function contractDeliveryState(contractStatus: string, stages: DeliveryStageInput[], escrow: DeliveryEscrowInput, disputeStatus: string | null = null) {
  const per = stages.map(s => stageDeliveryState(contractStatus, s));
  const canUploadDelivery = per.some(s => s.canUploadDelivery);
  const awaiting = per.some(s => s.awaitingClientReview);
  const uploadBlockedReason: string | null = canUploadDelivery ? null
    : contractStatus !== 'ACTIVE' ? (CONTRACT_BLOCK_REASON[contractStatus] || 'العقد غير نشط')
    : !per.length ? 'لم تُجهَّز مراحل المشروع بعد'
    : awaiting ? 'التسليم الحالي بانتظار مراجعة العميل'
    : stages.every(s => s.status === 'APPROVED') ? 'اعتُمدت كل المراحل'
    : 'لا توجد مرحلة مفتوحة للتسليم حالياً';
  return {
    contractStatus,
    ...escrowFacts(escrow),
    disputeStatus,
    canUploadDelivery,
    canSubmitDelivery: canUploadDelivery,
    uploadBlockedReason,
    awaitingClientReview: awaiting,
    revisionRequested: per.some(s => s.revisionRequested),
    revisionResubmitted: per.some(s => s.revisionResubmitted)
  };
}

/** Provider "active projects" list row status (wait = waiting for the CLIENT's reply, pending = contract not started yet). */
export function listStatus(state: ReturnType<typeof contractDeliveryState>, daysLeft: number, progress: number): { status: 'wait' | 'run' | 'late' | 'pending'; statusLabel: string } {
  const c = state.contractStatus;
  if (c === 'PENDING_PROVIDER_SIGNATURE') return { status: 'pending', statusLabel: 'بانتظار توقيعك على العقد' };
  if (c === 'PENDING_CLIENT_SIGNATURE') return { status: 'pending', statusLabel: 'بانتظار توقيع العميل' };
  if (c === 'PENDING_PAYMENT') return { status: 'pending', statusLabel: 'بانتظار إيداع العميل للضمان' };
  if (c !== 'ACTIVE') return { status: 'pending', statusLabel: ({ COMPLETED: 'مكتمل', CANCELLED: 'ملغى', DISPUTED: 'قيد نزاع' } as Record<string, string>)[c] || 'غير نشط' };
  if (daysLeft === 0 && progress < 100) return { status: 'late', statusLabel: 'متأخر' };
  if (state.revisionRequested) return { status: 'run', statusLabel: 'مطلوب تعديل منك' };
  if (state.awaitingClientReview) return { status: 'wait', statusLabel: state.revisionResubmitted ? 'أُعيد التسليم، بانتظار رد العميل' : 'بانتظار رد العميل' };
  return { status: 'run', statusLabel: 'قيد التنفيذ' };
}

/** State of one edit (revision request) card: still owed by the provider, re-delivered, or the stage was approved afterwards. */
export function editState(stageStatus: string, indexInStage: number, deliveriesCount: number) {
  if (stageStatus === 'APPROVED') return { status: 'approved', statusText: 'اعتُمدت المرحلة بعد التعديل' };
  if (indexInStage < deliveriesCount - 1) {
    return indexInStage === deliveriesCount - 2 && stageStatus === 'SUBMITTED'
      ? { status: 'resubmitted', statusText: 'أُعيد التسليم، بانتظار مراجعة العميل' }
      : { status: 'resubmitted', statusText: 'أُعيد التسليم' };
  }
  return { status: 'waiting', statusText: 'بانتظار إعادة التسليم' };
}
