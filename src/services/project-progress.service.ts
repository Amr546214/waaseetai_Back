import { AmendmentStatus, ContractStatus, EscrowStatus, ProjectStageStatus, ProjectStatus, RequestStatus, StageDeliveryStatus } from '@prisma/client';
import { prisma } from '../config/db';
import { AppError } from '../utils/app-error';
import { notificationService } from './notification.service';
import { emailService } from './email.service';
import { deriveProviderProgression } from '../utils/progression-calculators';
import { geminiClient } from './ai/gemini/gemini.client';

const PROJECT_COMPLETION_POINTS = 50;

const stageLabels: Record<string, [string, string]> = {
  PENDING: ['pending', 'لم تبدأ بعد'], IN_PROGRESS: ['in_progress', 'قيد التنفيذ'],
  SUBMITTED: ['submitted', 'بانتظار مراجعة العميل'], REVISION_REQUESTED: ['revision', 'مطلوب تعديل'],
  APPROVED: ['completed', 'مكتملة ومعتمدة']
};
const deliveryLabels: Record<string, [string, string]> = {
  SUBMITTED: ['pending', 'قيد مراجعة العميل'], REVISION_REQUESTED: ['notes', 'مطلوب تعديل'], APPROVED: ['approved', 'معتمد']
};
const nameFromUrl = (url: string) => {
  try { return decodeURIComponent(new URL(url).pathname.split('/').pop() || 'ملف مرفق'); }
  catch { return url.split('/').pop() || 'ملف مرفق'; }
};

// Normalize a single file entry from StageDelivery.files (String[]).
// Entries can be: (a) JSON-stringified objects {name,url,type,size}, or (b) plain URL strings (legacy).
// Always returns { name, url, type?, size? }.
const normalizeFileEntry = (entry: string): { name: string; url: string; type?: string; size?: number } => {
  if (typeof entry !== 'string') return { name: 'ملف مرفق', url: '' };
  const trimmed = entry.trim();
  // Try parsing as JSON object first
  if (trimmed.startsWith('{')) {
    try {
      const obj = JSON.parse(trimmed);
      return {
        name: obj.name || obj.fileName || (obj.url ? nameFromUrl(obj.url) : 'ملف مرفق'),
        url: obj.url || obj.fileUrl || obj.file_url || '',
        type: obj.type || obj.mimeType || undefined,
        size: typeof obj.size === 'number' ? obj.size : undefined
      };
    } catch { /* fall through to URL handling */ }
  }
  // Legacy: plain URL string
  return { name: nameFromUrl(trimmed), url: trimmed };
};

// Batch 5 — advisory-only delivery AI review. This never approves/rejects a
// delivery, releases/holds payment, or changes any status — the existing
// reviewDelivery()/submitDelivery() methods above remain the sole authority
// on all of that. Zero DB writes; generated on demand, never persisted.
export interface DeliveryAiReview {
  summary: string;
  alignedPoints: string[];
  potentialGaps: string[];
  questionsForReviewer: string[];
  reviewedInputs: {
    deliveryText: boolean;
    stageRequirements: boolean;
    // Always false in this v1 — file content is never fetched/inspected,
    // only filename/type/size metadata. Set exclusively by application
    // code below; Gemini's output is never trusted for this field (the
    // schema/validator don't even expose it to the model).
    attachmentContent: boolean;
  };
}

const DELIVERY_AI_MAX_SUMMARY_LENGTH = 900;
const DELIVERY_AI_MAX_ARRAY_ITEMS = 6;
const DELIVERY_AI_MAX_ARRAY_ITEM_LENGTH = 300;

const DELIVERY_AI_REVIEW_SCHEMA = {
  type: 'object',
  properties: {
    summary: { type: 'string', description: 'ملخص محايد وغير حاسم لمدى توافق التسليم مع متطلبات المرحلة، دون إصدار أي قرار قبول أو رفض.' },
    alignedPoints: { type: 'array', items: { type: 'string' }, description: 'نقاط في التسليم تبدو متوافقة مع المتطلبات المذكورة صراحة.' },
    potentialGaps: { type: 'array', items: { type: 'string' }, description: 'نقاط قد تكون غير متوافقة أو غير واضحة وتحتاج توضيحاً، دون الجزم بوجود خطأ.' },
    questionsForReviewer: { type: 'array', items: { type: 'string' }, description: 'أسئلة مقترحة يمكن للمستخدم (العميل أو مقدم الخدمة) طرحها قبل اتخاذ قراره النهائي.' }
  },
  required: ['summary', 'alignedPoints', 'potentialGaps', 'questionsForReviewer']
};

const DELIVERY_AI_REVIEW_SYSTEM_PROMPT = `أنت مساعد استشاري يحلّل تسليم مرحلة عمل لمستخدم بشري (عميل أو مقدم خدمة) مسؤول عن اتخاذ القرار النهائي في منصة وسيط. دورك استشاري بحت ولا تملك أي صلاحية قرار.
ممنوع تماماً: الموافقة على التسليم أو رفضه، إصدار حكم نهائي (verdict/pass/fail)، التوصية بالإفراج عن أي دفعة أو حجزها أو استرداد أي مبلغ، تحديد نسبة خطأ أو مسؤولية، أو التعبير عن "ثقة" بالقبول أو الرفض. القرار النهائي دائماً للمستخدم البشري عبر مسار القبول/طلب التعديل القائم فعلياً في المنصة؛ أنت لا تشارك في اتخاذه إطلاقاً ولا تلمّح إلى ما ينبغي فعله بالمال أو بحالة المشروع.
أسماء ونوع وحجم الملفات المرفقة أدناه (إن وُجدت) بيانات وصفية فقط — لم يتم فتح أو فحص محتوى أي ملف فعلياً، فلا تدّعِ الاطلاع على محتوى أي مرفق مهما بدا اسمه دالاً على ذلك.
استخدم فقط المعلومات المذكورة صراحة أدناه من بيانات المشروع والمرحلة ونص التسليم. إن كانت متطلبات المرحلة غير واضحة أو ناقصة، اذكر ذلك بصراحة كنقطة غامضة أو كسؤال بدل اختراع متطلبات غير مذكورة.
أجب بالعربية الفصحى الواضحة والمختصرة، وقدّم تحليلاً متوازناً وغير حاسم.`;

// Field names a genuinely advisory-only response must never contain — any of
// these appearing means Gemini attempted to issue a binding decision, and
// the whole response is rejected rather than sanitized.
const FORBIDDEN_DELIVERY_DECISION_KEYS = [
  'approved', 'rejected', 'pass', 'fail', 'verdict', 'decision', 'accept', 'reject',
  'releaseFunds', 'releasePayment', 'refund', 'refundAmount', 'paymentRecommendation',
  'faultPercentage', 'fraudScore', 'confidenceOfApproval', 'confidence', 'recommendedResolution',
  'winner', 'loser', 'status', 'deliveryStatus', 'projectStatus'
];

function isNonEmptyBoundedDeliveryString(value: unknown, maxLength: number): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= maxLength;
}

function isBoundedDeliveryStringArray(value: unknown): value is string[] {
  if (!Array.isArray(value) || value.length > DELIVERY_AI_MAX_ARRAY_ITEMS) return false;
  return value.every(item => typeof item === 'string' && item.length <= DELIVERY_AI_MAX_ARRAY_ITEM_LENGTH);
}

// Only validates the 4 Gemini-generated fields — reviewedInputs is never
// part of the schema Gemini answers, so there is nothing for this validator
// to check or trust on that front; it is always assembled separately by
// application code in getDeliveryAiReview() below.
function isValidDeliveryAiReviewContent(value: unknown): value is Omit<DeliveryAiReview, 'reviewedInputs'> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const v = value as Record<string, unknown>;
  if (Object.keys(v).length !== 4) return false;
  if (FORBIDDEN_DELIVERY_DECISION_KEYS.some(key => key in v)) return false;
  if (!isNonEmptyBoundedDeliveryString(v.summary, DELIVERY_AI_MAX_SUMMARY_LENGTH)) return false;
  if (!isBoundedDeliveryStringArray(v.alignedPoints)) return false;
  if (!isBoundedDeliveryStringArray(v.potentialGaps)) return false;
  if (!isBoundedDeliveryStringArray(v.questionsForReviewer)) return false;
  return true;
}

// Batch 8 — advisory-only Gemini project health analysis. Replaces the
// permanent aiInsights placeholder (confidence:0/riskLevel:'غير محسوبة'/
// bullets:[]) that getProjectProgress() has always returned. This single
// capability covers Contract Monitoring, Project Health, Predictive Delay
// Risk, and Predictive Dispute Risk — one real feature, not four. Read-only:
// zero DB writes. Nothing here can release/hold funds, approve/reject a
// delivery, resolve a dispute, or change any status — those remain the sole
// authority of reviewDelivery()/dispute resolution/contract management,
// exactly as with getDeliveryAiReview() above.
export interface ProjectHealthAnalysis {
  confidence: number;
  riskLevel: string;
  riskLevelKey: 'LOW' | 'MEDIUM' | 'HIGH' | 'UNKNOWN';
  healthRating: string;
  bullets: string[];
  // Real, deterministic (never Gemini-derived): positive = ahead of the
  // planned schedule, negative = behind. null only in the "not enough data
  // yet" short-circuit below.
  earlyDays: number | null;
  // Never applicable to project health (there is no real "match percentage"
  // concept here) — always null. Preserved only so the existing frontend
  // aiInsights contract (and its "—" fallback rendering) needs no change.
  matchPercentage: null;
}

const PROJECT_HEALTH_MAX_TEXT_LENGTH = 400;
const PROJECT_HEALTH_MAX_BULLETS = 5;
const PROJECT_HEALTH_MAX_BULLET_LENGTH = 240;
const PROJECT_HEALTH_RISK_KEYS = ['LOW', 'MEDIUM', 'HIGH'] as const;
const PROJECT_HEALTH_RISK_LABELS: Record<string, string> = {
  LOW: 'منخفضة', MEDIUM: 'متوسطة', HIGH: 'مرتفعة'
};

const PROJECT_HEALTH_SCHEMA = {
  type: 'object',
  properties: {
    riskLevelKey: { type: 'string', enum: ['LOW', 'MEDIUM', 'HIGH'], description: 'تصنيف مستوى المخاطرة العام للمشروع بناءً على بيانات الجدولة والمراحل المذكورة فقط.' },
    healthRating: { type: 'string', description: 'عبارة عربية قصيرة (جملة واحدة كحد أقصى) تلخّص الحالة العامة للمشروع، دون إصدار أي قرار أو توصية مالية أو تعاقدية.' },
    confidence: { type: 'number', description: 'مستوى ثقة النموذج في هذا التقييم الاستشاري، رقم من 0 إلى 100.' },
    bullets: { type: 'array', items: { type: 'string' }, description: 'حتى 5 ملاحظات موجزة توضح أسباب التقييم (مثل التزام الجدول، عدد طلبات التعديل، وجود نزاعات)، بصياغة وصفية غير حاسمة.' }
  },
  required: ['riskLevelKey', 'healthRating', 'confidence', 'bullets']
};

const PROJECT_HEALTH_SYSTEM_PROMPT = `أنت مساعد استشاري يحلّل الحالة العامة لمشروع نشط على منصة وسيط، بالاعتماد فقط على بيانات جدولة ومراحل وتسليمات حقيقية مذكورة أدناه. دورك استشاري بحت ولا تملك أي صلاحية قرار من أي نوع.
ممنوع تماماً وبأي صياغة: الإفراج عن أي دفعة أو حجزها أو استردادها، إنهاء أو إلغاء العقد، الموافقة على أي تسليم أو رفضه، حل أي نزاع أو تحديد الطرف المسؤول عنه، تعليق أي حساب، أو تغيير حالة المشروع أو العقد أو الضمان المالي. اتخاذ أي من هذه القرارات يبقى دائماً للأطراف البشرية عبر المسارات القائمة فعلياً في المنصة؛ أنت لا تشارك فيها إطلاقاً ولا تلمّح إلى ما ينبغي فعله بالمال أو بحالة المشروع أو العقد.
استخدم فقط الحقائق المذكورة صراحة أدناه. لا تخترع بيانات غير مذكورة (مثل أسماء أو تفاصيل غير واردة). إن كانت البيانات غير كافية لتقييم واضح، اذكر ذلك صراحة في الملاحظات بدل افتراض نتيجة إيجابية.
أجب بالعربية الفصحى الواضحة والمختصرة.`;

// Mirrors FORBIDDEN_DELIVERY_DECISION_KEYS above, expanded with the
// contract/escrow/dispute/account-level actions this capability must also
// never attempt (Batch 8 safety requirement).
const FORBIDDEN_PROJECT_HEALTH_KEYS = [
  'approved', 'rejected', 'pass', 'fail', 'verdict', 'decision', 'accept', 'reject',
  'releaseFunds', 'releasePayment', 'refund', 'refundAmount', 'paymentRecommendation',
  'faultPercentage', 'fraudScore', 'confidenceOfApproval', 'recommendedResolution',
  'winner', 'loser', 'status', 'deliveryStatus', 'projectStatus', 'contractStatus',
  'escrowStatus', 'terminate', 'terminateContract', 'cancelContract', 'suspend',
  'suspendAccount', 'resolveDispute', 'disputeResolution', 'assignFault', 'faultAssignment'
];

interface ProjectHealthGeminiContent {
  riskLevelKey: 'LOW' | 'MEDIUM' | 'HIGH';
  healthRating: string;
  confidence: number;
  bullets: string[];
}

function isValidProjectHealthContent(value: unknown): value is ProjectHealthGeminiContent {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const v = value as Record<string, unknown>;
  if (Object.keys(v).length !== 4) return false;
  if (FORBIDDEN_PROJECT_HEALTH_KEYS.some(key => key in v)) return false;
  if (typeof v.riskLevelKey !== 'string' || !(PROJECT_HEALTH_RISK_KEYS as readonly string[]).includes(v.riskLevelKey)) return false;
  if (typeof v.healthRating !== 'string' || !v.healthRating.trim() || v.healthRating.length > PROJECT_HEALTH_MAX_TEXT_LENGTH) return false;
  if (typeof v.confidence !== 'number' || !Number.isFinite(v.confidence) || v.confidence < 0 || v.confidence > 100) return false;
  if (!Array.isArray(v.bullets) || v.bullets.length === 0 || v.bullets.length > PROJECT_HEALTH_MAX_BULLETS) return false;
  if (!v.bullets.every(b => typeof b === 'string' && b.trim().length > 0 && b.length <= PROJECT_HEALTH_MAX_BULLET_LENGTH)) return false;
  return true;
}

export class ProjectProgressService {
  private async ensureStages(contractId: string) {
    const found = await prisma.projectStage.findMany({ where: { contractId }, orderBy: { stepOrder: 'asc' } });
    if (found.length) return;
    const contract = await prisma.contract.findUnique({ where: { id: contractId }, include: { project: true } });
    if (!contract) throw new AppError('العقد غير موجود', 404);
    const proposal = contract.offerId
      ? await prisma.projectProposal.findUnique({ where: { id: contract.offerId }, include: { milestones: { orderBy: { stepOrder: 'asc' } } } })
      : await prisma.projectProposal.findFirst({ where: { projectId: contract.projectId, providerId: contract.providerId }, include: { milestones: { orderBy: { stepOrder: 'asc' } } } });
    const source = proposal?.milestones.length ? proposal.milestones : [{
      stepOrder: 1, title: 'تسليم المشروع النهائي', description: contract.project.description,
      days: contract.durationDays, percentage: 100, amount: contract.price
    }];
    try {
      await prisma.projectStage.createMany({ data: source.map((item, index) => ({
        contractId, stepOrder: item.stepOrder || index + 1, title: item.title, description: item.description,
        days: item.days, percentage: item.percentage, amount: item.amount,
        status: index === 0 && contract.status === ContractStatus.ACTIVE ? ProjectStageStatus.IN_PROGRESS : ProjectStageStatus.PENDING,
        startedAt: index === 0 && contract.status === ContractStatus.ACTIVE ? (contract.signedAt || new Date()) : null
      })) });
    } catch (error: any) { if (error?.code !== 'P2002') throw error; }
  }

  async getProjectProgress(userId: string, key: string) {
    const contract = await prisma.contract.findFirst({
      where: { OR: [{ projectId: key }, { id: key }], AND: [{ OR: [{ providerId: userId }, { clientId: userId }] }] },
      include: {
        project: { include: { escrow: true, conversations: { include: { messages: { orderBy: { createdAt: 'asc' }, include: { sender: { select: { id: true, firstName: true, lastName: true } } } } } } } },
        client: { select: { id: true, firstName: true, lastName: true } },
        provider: { select: { id: true, firstName: true, lastName: true } }
      }
    });
    if (!contract) {
      // No contract yet (e.g. PENDING_SIGNATURE before contract creation).
      // Fall back to a Project lookup so the client can still open the workspace
      // and see the pre-contract state. Ownership is still enforced via clientId.
      const project = await prisma.project.findFirst({
        where: { id: key, clientId: userId },
        include: {
          escrow: true,
          proposals: { where: { status: 'ACCEPTED' }, include: { provider: { select: { id: true, firstName: true, lastName: true } } }, orderBy: { createdAt: 'desc' }, take: 1 }
        }
      });
      if (!project) throw new AppError('المشروع غير موجود أو لا تملك صلاحية الوصول إليه', 404);
      const acceptedProp = project.proposals?.[0] || null;
      const providerUser = acceptedProp?.provider || null;
      const providerName = providerUser ? `${providerUser.firstName || ''} ${providerUser.lastName || ''}`.trim() : 'مقدم الخدمة';
      return {
        id: null, projectId: project.id, role: 'client', conversationId: null,
        title: project.title, clientName: providerName, clientInitial: providerName.charAt(0) || 'م',
        contractRef: `CT-${project.id.slice(0, 6).toUpperCase()}`,
        price: acceptedProp ? Number(acceptedProp.price || 0) : 0, durationDays: project.deliveryDays || 0,
        daysLeft: project.deliveryDays || 0, progress: 0,
        escrowTotal: project.escrow?.amount || 0, escrowHeld: project.escrow?.amount || 0, escrowReleased: 0,
        status: 'PENDING_SIGNATURE', statusLabel: 'بانتظار توقيع العقد',
        stages: [], deliveries: [], edits: [], messages: [], files: [],
        aiInsights: { confidence: 0, earlyDays: 0, matchPercentage: null, riskLevel: 'غير محسوبة', riskLevelKey: 'unknown', healthRating: 'بانتظار بيانات كافية', bullets: [] }
      };
    }
    await this.ensureStages(contract.id);
    // Stage reviews are always written by the client. When the provider calls this endpoint,
    // userId is the provider's id, so filtering by clientId: userId would return empty.
    // Resolve the actual reviewer id (the contract's client) so both sides see the rating.
    const reviewerId = contract.providerId === userId ? contract.clientId : userId;
    const persisted = await prisma.projectStage.findMany({ where: { contractId: contract.id }, orderBy: { stepOrder: 'asc' }, include: { deliveries: { orderBy: { submittedAt: 'asc' } }, stageReviews: { where: { clientId: reviewerId } } } });
    const role = contract.providerId === userId ? 'provider' : 'client';
    const other = role === 'provider' ? contract.client : contract.provider;
    const otherName = `${other.firstName || (role === 'provider' ? 'العميل' : 'مقدم الخدمة')} ${other.lastName || ''}`.trim();
    let conversation = contract.project.conversations.find(c => c.providerId === contract.providerId && c.clientId === contract.clientId);
    if (!conversation) {
      conversation = await prisma.conversation.upsert({
        where: { projectId_providerId: { projectId: contract.projectId, providerId: contract.providerId } },
        update: {},
        create: { projectId: contract.projectId, providerId: contract.providerId, clientId: contract.clientId, offerId: contract.offerId || null },
        include: { messages: { orderBy: { createdAt: 'asc' }, include: { sender: { select: { id: true, firstName: true, lastName: true } } } } }
      });
    }
    const released = contract.project.escrow?.releasedAmount || 0;
    const stages = persisted.map(stage => {
      const [status, statusText] = stageLabels[stage.status];
      const stageReview = (stage as any).stageReviews?.[0] || null;
      return {
        id: stage.id, stageNumber: stage.stepOrder, title: stage.title, description: stage.description,
        amount: stage.amount, percentage: stage.percentage, days: stage.days,
        isDone: stage.status === ProjectStageStatus.APPROVED,
        isWait: stage.status === ProjectStageStatus.IN_PROGRESS || stage.status === ProjectStageStatus.SUBMITTED || stage.status === ProjectStageStatus.REVISION_REQUESTED,
        status, statusText, completedDate: stage.approvedAt, roundsCount: stage.deliveries.length,
        hasClientRating: !!stageReview,
        clientRating: stageReview?.rating || null,
        clientRatingComment: stageReview?.comment || null,
        threads: stage.deliveries.map((delivery, index) => ({
          id: delivery.id, author: role === 'provider' ? 'أنت' : `${contract.provider.firstName || 'مقدم الخدمة'} ${contract.provider.lastName || ''}`.trim(),
          authorInitial: contract.provider.firstName?.charAt(0) || 'م', isMe: role === 'provider', tag: `التسليم ${index + 1}`,
          isRedo: index > 0, date: delivery.submittedAt, note: delivery.note,
          files: delivery.files.map(url => normalizeFileEntry(url)), reviewNote: delivery.reviewNote, deliveryStatus: delivery.status
        }))
      };
    });
    const deliveries = persisted.flatMap(stage => stage.deliveries.map((delivery, index) => {
      const [status, statusText] = deliveryLabels[delivery.status];
      return { id: delivery.id, stageId: stage.id, stageTitle: stage.title, stageNumber: stage.stepOrder,
        title: stage.title, status, statusText, submittedAt: delivery.submittedAt, roundText: `التسليم ${index + 1}`,
        summary: delivery.note, reviewNote: delivery.reviewNote, files: delivery.files.map(url => normalizeFileEntry(url)) };
    }));
    const messages = (conversation?.messages || []).map(message => ({
      id: message.id, senderName: message.senderId === userId ? 'أنت' : `${message.sender.firstName || otherName} ${message.sender.lastName || ''}`.trim(),
      senderInitial: (message.sender.firstName || otherName).charAt(0), senderRole: message.senderId === contract.providerId ? 'provider' : 'client',
      isMe: message.senderId === userId, time: message.createdAt, content: message.content || message.fileName || 'مرفق', fileUrl: message.fileUrl, fileName: message.fileName
    }));
    const progress = Math.min(100, Math.round(persisted.filter(s => s.status === ProjectStageStatus.APPROVED).reduce((sum, s) => sum + s.percentage, 0)));
    const elapsed = Math.max(0, Math.floor((Date.now() - (contract.signedAt || contract.createdAt).getTime()) / 86400000));
    // Provider → Client final rating status (for provider-side read-only display).
    // A final project rating by the provider has stageId = null and is written by the provider.
    let providerClientRating: { hasRated: boolean; rating: number | null; comment: string | null; ratedAt: string | null } = {
      hasRated: false, rating: null, comment: null, ratedAt: null
    };
    if (role === 'provider') {
      const existingReview = await prisma.review.findFirst({
        where: { providerId: userId, projectId: contract.projectId, stageId: null, clientId: contract.clientId, reviewerRole: 'PROVIDER' },
        select: { rating: true, comment: true, createdAt: true }
      });
      if (existingReview) {
        providerClientRating = {
          hasRated: true,
          rating: existingReview.rating,
          comment: existingReview.comment || null,
          ratedAt: existingReview.createdAt ? existingReview.createdAt.toISOString() : null
        };
      }
    }

    return {
      id: contract.id, projectId: contract.projectId, role, conversationId: conversation?.id || null,
      title: contract.project.title, clientName: otherName, clientInitial: otherName.charAt(0) || 'ع', contractRef: `CT-${contract.id.slice(0, 6).toUpperCase()}`,
      price: contract.price, durationDays: contract.durationDays, daysLeft: Math.max(0, contract.durationDays - elapsed), progress,
      escrowTotal: contract.project.escrow?.amount || contract.price, escrowHeld: Math.max(0, (contract.project.escrow?.amount || contract.price) - released), escrowReleased: released,
      status: contract.status, statusLabel: contract.status === ContractStatus.COMPLETED ? 'مكتمل' : contract.status === ContractStatus.ACTIVE ? 'مشروع نشط' : 'بانتظار بدء المشروع',
      stages, deliveries,
      edits: deliveries.filter(d => d.status === 'notes').map(d => ({ id: d.id, stageId: d.stageId, stageTitle: d.stageTitle, title: `ملاحظات على ${d.stageTitle}`, clientNotes: d.reviewNote || '', status: 'waiting', statusText: 'بانتظار إعادة التسليم', createdAt: d.submittedAt })),
      messages,
      files: persisted.filter(s => s.deliveries.some(d => d.files.length)).map(s => ({ groupTitle: s.title, isDone: s.status === ProjectStageStatus.APPROVED, files: s.deliveries.flatMap(d => d.files.map(url => normalizeFileEntry(url))) })),
      providerClientRating,
      aiInsights: { confidence: 0, earlyDays: 0, matchPercentage: null, riskLevel: 'غير محسوبة', riskLevelKey: 'unknown', healthRating: 'بانتظار بيانات كافية', bullets: [] }
    };
  }

  // Stages awaiting THIS client's review decision, across all of their active
  // contracts. "Reviewable" is defined identically to reviewDelivery()'s own
  // guard below (stage.status === SUBMITTED AND the latest delivery for that
  // stage is itself still SUBMITTED) so this list can never show an item that
  // the real approve/revision endpoint would then reject as stale.
  async getPendingReviewDeliveries(clientId: string) {
    const stages = await prisma.projectStage.findMany({
      where: {
        status: ProjectStageStatus.SUBMITTED,
        contract: { clientId, status: ContractStatus.ACTIVE }
      },
      orderBy: [{ contract: { updatedAt: 'desc' } }, { stepOrder: 'asc' }],
      include: {
        contract: {
          select: {
            id: true,
            projectId: true,
            project: { select: { title: true } },
            provider: { select: { firstName: true, lastName: true } }
          }
        },
        deliveries: { orderBy: { submittedAt: 'desc' }, take: 1 }
      }
    });

    return stages
      .filter(stage => stage.deliveries[0]?.status === StageDeliveryStatus.SUBMITTED)
      .map(stage => {
        const delivery = stage.deliveries[0];
        const provider = stage.contract.provider;
        return {
          projectId: stage.contract.projectId,
          projectTitle: stage.contract.project.title,
          stageId: stage.id,
          stageNumber: stage.stepOrder,
          stageTitle: stage.title,
          amount: stage.amount,
          submittedAt: delivery.submittedAt,
          providerName: `${provider.firstName || 'مقدم الخدمة'} ${provider.lastName || ''}`.trim(),
          filesCount: delivery.files.length,
          contractRef: `CT-${stage.contract.id.slice(0, 6).toUpperCase()}`
        };
      });
  }

  async submitDelivery(providerId: string, key: string, stageId: string, note: string, files: any[]) {
    if (!note?.trim() || note.trim().length < 10) throw new AppError('أضف وصفاً واضحاً للتسليم (10 أحرف على الأقل)', 400);
    const contract = await prisma.contract.findFirst({ where: { OR: [{ id: key }, { projectId: key }], providerId } });
    if (!contract || contract.status !== ContractStatus.ACTIVE) throw new AppError('العقد غير نشط أو لا تملك صلاحية التسليم', 403);
    await this.ensureStages(contract.id);
    const stage = await prisma.projectStage.findFirst({ where: { id: stageId, contractId: contract.id } });
    if (!stage || (stage.status !== ProjectStageStatus.IN_PROGRESS && stage.status !== ProjectStageStatus.REVISION_REQUESTED)) throw new AppError('هذه المرحلة غير متاحة للتسليم حالياً', 409);
    // Accept both file objects ({name,url,type,size}) and plain URL strings.
    // Serialize each entry to a JSON string for storage in String[] column.
    const safeFiles: string[] = Array.isArray(files)
      ? files
          .filter(v => v != null)
          .map(v => {
            if (typeof v === 'string') return v.trim() ? v.trim() : null;
            if (typeof v === 'object') {
              const url = v.url || v.fileUrl || v.file_url || '';
              if (!url) return null;
              return JSON.stringify({ name: v.name || v.fileName || nameFromUrl(url), url, type: v.type || v.mimeType || '', size: typeof v.size === 'number' ? v.size : 0 });
            }
            return null;
          })
          .filter((v): v is string => v !== null)
          .slice(0, 10)
      : [];
    console.log('[submitDelivery] safeFiles count:', safeFiles.length, 'sample:', safeFiles.slice(0, 2));
    return prisma.$transaction(async tx => {
      const delivery = await tx.stageDelivery.create({ data: { stageId, providerId, note: note.trim(), files: safeFiles } });
      console.log('[submitDelivery] created delivery id:', delivery.id, 'files:', JSON.stringify(delivery.files));
      await tx.projectStage.update({ where: { id: stageId }, data: { status: ProjectStageStatus.SUBMITTED } });
      await tx.project.update({ where: { id: contract.projectId }, data: { status: ProjectStatus.AWAITING_DELIVERY } });
      await tx.notification.create({ data: { userId: contract.clientId, title: 'تسليم جديد بانتظار مراجعتك', message: `تم تسليم مرحلة: ${stage.title}`, type: 'STAGE_DELIVERY', category: 'PROJECTS', actionUrl: `/client-overview/projects/${contract.projectId}`, metadata: { projectId: contract.projectId, stageId, deliveryId: delivery.id } } });
      return delivery;
    });
  }

  async reviewDelivery(clientId: string, key: string, stageId: string, decision: string, note?: string) {
    if (!['approve', 'revision'].includes(decision)) throw new AppError('قرار المراجعة غير صالح', 400);
    if (decision === 'revision' && (!note?.trim() || note.trim().length < 10)) throw new AppError('اكتب ملاحظات التعديل بوضوح', 400);
    const contract = await prisma.contract.findFirst({
      where: { OR: [{ id: key }, { projectId: key }], clientId },
      include: {
        project: { select: { title: true } },
        provider: { select: { firstName: true, lastName: true, email: true } }
      }
    });
    if (!contract || contract.status !== ContractStatus.ACTIVE) throw new AppError('العقد غير نشط أو لا تملك صلاحية المراجعة', 403);
    const stage = await prisma.projectStage.findFirst({ where: { id: stageId, contractId: contract.id }, include: { deliveries: { orderBy: { submittedAt: 'desc' }, take: 1 } } });
    const delivery = stage?.deliveries[0];
    if (!stage || stage.status !== ProjectStageStatus.SUBMITTED || !delivery || delivery.status !== StageDeliveryStatus.SUBMITTED) throw new AppError('لا يوجد تسليم جديد بانتظار المراجعة لهذه المرحلة', 409);
    const result = await prisma.$transaction(async tx => {
      let isProjectCompleted = false;
      if (decision === 'revision') {
        await tx.stageDelivery.update({ where: { id: delivery.id }, data: { status: StageDeliveryStatus.REVISION_REQUESTED, reviewNote: note!.trim(), reviewedAt: new Date() } });
        await tx.projectStage.update({ where: { id: stage.id }, data: { status: ProjectStageStatus.REVISION_REQUESTED } });
        await tx.project.update({ where: { id: contract.projectId }, data: { status: ProjectStatus.IN_PROGRESS } });
      } else {
        await tx.stageDelivery.update({ where: { id: delivery.id }, data: { status: StageDeliveryStatus.APPROVED, reviewNote: note?.trim() || null, reviewedAt: new Date() } });
        await tx.projectStage.update({ where: { id: stage.id }, data: { status: ProjectStageStatus.APPROVED, approvedAt: new Date() } });
        const next = await tx.projectStage.findFirst({ where: { contractId: contract.id, stepOrder: { gt: stage.stepOrder } }, orderBy: { stepOrder: 'asc' } });
        if (next) {
          await tx.projectStage.update({ where: { id: next.id }, data: { status: ProjectStageStatus.IN_PROGRESS, startedAt: new Date() } });
          await tx.project.update({ where: { id: contract.projectId }, data: { status: ProjectStatus.IN_PROGRESS } });
          await tx.escrow.updateMany({ where: { projectId: contract.projectId }, data: { releasedAmount: { increment: stage.amount } } });
        } else {
          isProjectCompleted = true;
          const completed = await tx.contract.updateMany({
            where: { id: contract.id, status: { not: ContractStatus.COMPLETED } },
            data: { status: ContractStatus.COMPLETED }
          });
          if (completed.count !== 1) throw new AppError('تم اعتماد المشروع النهائي مسبقاً', 409);
          await tx.project.update({ where: { id: contract.projectId }, data: { status: ProjectStatus.COMPLETED, providerId: contract.providerId } });
          await tx.escrow.updateMany({ where: { projectId: contract.projectId }, data: { status: EscrowStatus.RELEASED, releasedAmount: contract.price } });
          await tx.clientRequest.updateMany({
            where: { proposals: { some: { projectId: contract.projectId } } },
            data: { status: RequestStatus.COMPLETED }
          });

          await tx.pointTransaction.create({
            data: {
              providerId: contract.providerId,
              amount: PROJECT_COMPLETION_POINTS,
              reason: 'PROJECT_COMPLETED',
              description: `إكمال مشروع بنجاح: ${contract.project.title} (${contract.id})`
            }
          });
          // Phase 3D.3A: avgRating is sourced the same way getLevelDetails()
          // already does — a live Review aggregate (CLIENT -> PROVIDER
          // reviews only) — not the ProviderGamification cache, which would
          // be a stale read of the very row this same block is about to
          // write. All three reads run inside this same transaction, so they
          // see this transaction's own already-committed PointTransaction.
          const [pointsAggregate, completedProjects, ratingAggregate] = await Promise.all([
            tx.pointTransaction.aggregate({ where: { providerId: contract.providerId }, _sum: { amount: true } }),
            tx.project.count({ where: { providerId: contract.providerId, status: ProjectStatus.COMPLETED } }),
            tx.review.aggregate({ where: { providerId: contract.providerId, reviewerRole: 'CLIENT' }, _avg: { rating: true } })
          ]);
          const totalPoints = pointsAggregate._sum.amount || 0;
          const avgRating = Number(ratingAggregate._avg.rating || 0);
          const progression = deriveProviderProgression({ points: totalPoints, completedProjects, avgRating });
          await Promise.all([
            tx.user.update({ where: { id: contract.providerId }, data: { currentPoints: totalPoints } }),
            tx.providerGamification.upsert({
              where: { providerId: contract.providerId },
              update: {
                points: totalPoints,
                completedProjects,
                avgRating,
                currentLevelIndex: progression.currentLevelIndex,
                currentCommission: progression.currentCommission
              },
              create: {
                providerId: contract.providerId,
                points: totalPoints,
                completedProjects,
                avgRating,
                currentLevelIndex: progression.currentLevelIndex,
                currentCommission: progression.currentCommission
              }
            }),
            tx.gamificationRule.upsert({
              where: { code: 'GAIN_PROJECT_COMPLETE' },
              update: { points: PROJECT_COMPLETION_POINTS, label: 'إكمال مشروع بنجاح' },
              create: { code: 'GAIN_PROJECT_COMPLETE', type: 'GAIN', label: 'إكمال مشروع بنجاح', points: PROJECT_COMPLETION_POINTS }
            })
          ]);
        }
      }
      const notification = await tx.notification.create({
        data: {
          userId: contract.providerId,
          title: isProjectCompleted ? `🎉 اكتمل المشروع وربحت +${PROJECT_COMPLETION_POINTS} نقطة` : decision === 'approve' ? 'تم اعتماد التسليم' : 'مطلوب تعديل على التسليم',
          message: isProjectCompleted ? `وافق العميل على التسليم النهائي لمشروع «${contract.project.title}». تمت إضافة ${PROJECT_COMPLETION_POINTS} نقطة إلى رصيدك.` : decision === 'approve' ? `اعتمد العميل مرحلة: ${stage.title}` : note!.trim(),
          type: isProjectCompleted ? 'PROJECT_COMPLETION_REWARD' : 'STAGE_REVIEW',
          category: 'PROJECTS',
          actionUrl: `/provider-overview/projects/${contract.projectId}/progress`,
          actionText: isProjectCompleted ? 'عرض المشروع والنقاط' : 'عرض المشروع',
          metadata: { projectId: contract.projectId, contractId: contract.id, stageId, decision, ...(isProjectCompleted ? { pointsAwarded: PROJECT_COMPLETION_POINTS } : {}) }
        }
      });
      return {
        decision,
        stageId,
        notificationId: notification.id,
        isProjectCompleted,
        providerEmail: isProjectCompleted ? contract.provider.email : null,
        providerName: `${contract.provider.firstName || 'مقدم الخدمة'} ${contract.provider.lastName || ''}`.trim(),
        projectTitle: contract.project.title
      };
    });

    await notificationService.emitStored(result.notificationId).catch(error => {
      console.error('[ProjectProgress] Failed to emit project review notification:', error);
    });
    if (result.isProjectCompleted && result.providerEmail) {
      await emailService.sendProjectCompletionRewardEmail({
        email: result.providerEmail,
        providerName: result.providerName,
        projectTitle: result.projectTitle,
        pointsAwarded: PROJECT_COMPLETION_POINTS,
        projectUrl: `/provider-overview/projects/${contract.projectId}/progress`
      });
    }
    return { decision: result.decision, stageId: result.stageId, pointsAwarded: result.isProjectCompleted ? PROJECT_COMPLETION_POINTS : 0 };
  }

  /**
   * Batch 5 — advisory-only Gemini review of a single stage delivery, for
   * whichever of the two real parties (the contract's client or its
   * provider) is asking. Read-only: zero DB writes, and nothing here can
   * approve/reject the delivery, change ProjectStage/Project status, or
   * touch Escrow — reviewDelivery() above remains the only path that can do
   * any of that. The client only ever sends the contract/project key and
   * stageId; every fact in the prompt is fetched here from the DB.
   */
  async getDeliveryAiReview(userId: string, key: string, stageId: string): Promise<DeliveryAiReview> {
    const contract = await prisma.contract.findFirst({
      where: { OR: [{ id: key }, { projectId: key }] },
      select: {
        id: true, clientId: true, providerId: true,
        project: { select: { title: true, description: true, requirements: true } },
        amendments: {
          where: { status: AmendmentStatus.APPROVED },
          orderBy: { respondedAt: 'desc' },
          take: 5,
          select: { type: true, title: true, description: true, budgetDelta: true, durationDeltaDays: true }
        }
      }
    });
    if (!contract) throw new AppError('العقد غير موجود', 404);
    if (contract.clientId !== userId && contract.providerId !== userId) throw new AppError('لا تملك صلاحية الاطلاع على هذا التسليم', 403);

    const stage = await prisma.projectStage.findFirst({
      where: { id: stageId, contractId: contract.id },
      include: { deliveries: { orderBy: { submittedAt: 'desc' }, take: 1 } }
    });
    if (!stage) throw new AppError('المرحلة غير موجودة', 404);
    const delivery = stage.deliveries[0];
    if (!delivery) throw new AppError('لا يوجد تسليم لهذه المرحلة بعد', 404);

    const cap = (text: string | null | undefined, max = 1200) => (text && text.trim() ? text.trim().slice(0, max) : 'غير متوفر');

    const promptLines: string[] = [
      `عنوان المشروع: ${cap(contract.project.title, 300)}`,
      `وصف المشروع: ${cap(contract.project.description)}`,
    ];
    if (contract.project.requirements?.length) {
      promptLines.push(`متطلبات المشروع المعلنة: ${contract.project.requirements.slice(0, 15).map(r => cap(r, 200)).join(' | ')}`);
    }
    promptLines.push(
      `عنوان المرحلة رقم ${stage.stepOrder}: ${cap(stage.title, 200)}`,
      `وصف/متطلبات المرحلة: ${cap(stage.description)}`,
      `نص التسليم المُرسَل من مقدم الخدمة: ${cap(delivery.note)}`,
      `تاريخ الإرسال: ${delivery.submittedAt.toISOString()}`
    );

    const fileEntries = delivery.files.slice(0, 10).map(normalizeFileEntry);
    if (fileEntries.length) {
      promptLines.push(
        `ملفات مرفقة (بيانات وصفية فقط — اسم/نوع، لم يُفحص المحتوى): ${fileEntries.map(f => `${cap(f.name, 150)}${f.type ? ` (${f.type})` : ''}`).join(' | ')}`
      );
    } else {
      promptLines.push('لا توجد ملفات مرفقة مع هذا التسليم.');
    }

    if (contract.amendments.length) {
      promptLines.push('تعديلات معتمدة على العقد (على مستوى العقد، وليست بالضرورة خاصة بهذه المرحلة تحديداً):');
      for (const amendment of contract.amendments) {
        promptLines.push(`- [${amendment.type}] ${cap(amendment.title, 150)}: ${cap(amendment.description, 300)}`);
      }
    }

    let content: Omit<DeliveryAiReview, 'reviewedInputs'>;
    try {
      const result = await geminiClient.generateStructured<Omit<DeliveryAiReview, 'reviewedInputs'>>(promptLines.join('\n'), {
        systemInstruction: DELIVERY_AI_REVIEW_SYSTEM_PROMPT,
        responseSchema: DELIVERY_AI_REVIEW_SCHEMA,
        validate: isValidDeliveryAiReviewContent,
        temperature: 0.3,
        // Live-Gemini testing found 700 truncated this 4-field response
        // (a bounded summary plus 3 bounded string arrays — see the schema/
        // validator above) before it reached the honest validator, once
        // gemini-flash-latest's variable reasoning-token overhead is
        // accounted for. Raised with headroom for the full contract.
        maxOutputTokens: 2000,
        timeoutMs: 25 * 1000
      });
      content = result.data;
    } catch (error: any) {
      console.error('[ProjectProgressService] Delivery AI review generation failed:', error?.code || error?.message);
      throw error;
    }

    return {
      ...content,
      reviewedInputs: {
        deliveryText: Boolean(delivery.note?.trim()),
        stageRequirements: Boolean(stage.description?.trim() || contract.project.description?.trim() || contract.project.requirements?.length),
        attachmentContent: false
      }
    };
  }

  /**
   * Batch 8 — advisory-only Gemini project health analysis, on demand, for
   * whichever of the two real parties (the contract's client or its
   * provider) is asking. Read-only: zero DB writes, and nothing here can
   * change any status or touch escrow — see the forbidden-keys list and
   * system prompt above. No client/provider names/emails are sent to
   * Gemini, only project/stage titles and real numeric schedule signals.
   */
  async getProjectHealthAnalysis(userId: string, key: string): Promise<ProjectHealthAnalysis> {
    const contract = await prisma.contract.findFirst({
      where: { OR: [{ id: key }, { projectId: key }] },
      select: {
        id: true, clientId: true, providerId: true, projectId: true,
        durationDays: true, signedAt: true, createdAt: true,
        project: { select: { title: true } },
        amendments: { where: { status: AmendmentStatus.APPROVED }, select: { id: true } }
      }
    });
    if (!contract) throw new AppError('العقد غير موجود', 404);
    if (contract.clientId !== userId && contract.providerId !== userId) throw new AppError('لا تملك صلاحية الاطلاع على هذا المشروع', 403);

    const stages = await prisma.projectStage.findMany({
      where: { contractId: contract.id },
      orderBy: { stepOrder: 'asc' },
      select: { title: true, days: true, startedAt: true, status: true, deliveries: { select: { status: true } } }
    });

    // Nothing has started yet — genuinely nothing to analyze. Honest
    // "not enough data" result, no Gemini call at all (mirrors the
    // ZERO_AI_METRICS short-circuit pattern already used in
    // provider-profile.service.ts::generateAiMetrics).
    const hasAnyProgressSignal = stages.some(s => s.status !== ProjectStageStatus.PENDING || s.deliveries.length > 0);
    if (!hasAnyProgressSignal) {
      return {
        confidence: 0, riskLevel: 'غير محسوبة', riskLevelKey: 'UNKNOWN',
        healthRating: 'بانتظار بيانات كافية', bullets: [], earlyDays: null, matchPercentage: null
      };
    }

    const disputes = await prisma.dispute.findMany({
      where: { projectId: contract.projectId },
      select: { status: true }
    });

    const totalStages = stages.length;
    const completedStages = stages.filter(s => s.status === ProjectStageStatus.APPROVED).length;
    const revisionRequestCount = stages.reduce(
      (sum, s) => sum + s.deliveries.filter(d => d.status === StageDeliveryStatus.REVISION_REQUESTED).length, 0
    );
    const openDisputeCount = disputes.filter(d => d.status === 'OPEN' || d.status === 'UNDER_REVIEW').length;

    const elapsedDays = Math.max(0, Math.floor((Date.now() - (contract.signedAt || contract.createdAt).getTime()) / 86400000));
    const plannedTotalDays = Math.max(1, contract.durationDays);
    const expectedProgressRatio = Math.min(1, elapsedDays / plannedTotalDays);
    const actualProgressRatio = totalStages > 0 ? completedStages / totalStages : 0;
    // Real, deterministic — positive = ahead of schedule, negative = behind.
    // Never sent to Gemini as something to decide on; Gemini's schema does
    // not even expose a field for it (see PROJECT_HEALTH_SCHEMA above).
    const earlyDays = Math.round((actualProgressRatio - expectedProgressRatio) * plannedTotalDays);

    const currentStage = stages.find(s => s.status === ProjectStageStatus.IN_PROGRESS);
    let currentStageOverdueDays: number | null = null;
    if (currentStage?.startedAt) {
      const stageElapsed = Math.floor((Date.now() - currentStage.startedAt.getTime()) / 86400000);
      currentStageOverdueDays = Math.max(0, stageElapsed - currentStage.days);
    }

    const cap = (text: string | null | undefined, max = 300) => (text && text.trim() ? text.trim().slice(0, max) : 'غير متوفر');

    const promptLines: string[] = [
      `عنوان المشروع: ${cap(contract.project.title, 200)}`,
      `المدة الإجمالية المخطط لها: ${plannedTotalDays} يوم`,
      `الوقت المنقضي منذ توقيع العقد: ${elapsedDays} يوم`,
      `عدد المراحل الكلي: ${totalStages}، عدد المراحل المكتملة والمعتمدة: ${completedStages}`,
      `عدد طلبات التعديل (إعادة تسليم) على كل المراحل حتى الآن: ${revisionRequestCount}`,
      `عدد النزاعات المفتوحة أو قيد المراجعة على هذا المشروع: ${openDisputeCount}`,
      `عدد التعديلات المعتمدة على العقد: ${contract.amendments.length}`
    ];
    if (currentStage) {
      promptLines.push(`المرحلة الحالية قيد التنفيذ: "${cap(currentStage.title, 150)}"، المدة المخطط لها لهذه المرحلة ${currentStage.days} يوم.`);
      promptLines.push(
        currentStageOverdueDays && currentStageOverdueDays > 0
          ? `هذه المرحلة تجاوزت مدتها المخطط لها بـ ${currentStageOverdueDays} يوم حتى الآن.`
          : 'هذه المرحلة ضمن مدتها المخطط لها حتى الآن.'
      );
    } else {
      promptLines.push('لا توجد مرحلة قيد التنفيذ حالياً.');
    }

    let content: ProjectHealthGeminiContent;
    try {
      const result = await geminiClient.generateStructured<ProjectHealthGeminiContent>(promptLines.join('\n'), {
        systemInstruction: PROJECT_HEALTH_SYSTEM_PROMPT,
        responseSchema: PROJECT_HEALTH_SCHEMA,
        validate: isValidProjectHealthContent,
        temperature: 0.3,
        maxOutputTokens: 500,
        timeoutMs: 25 * 1000
      });
      content = result.data;
    } catch (error: any) {
      console.error('[ProjectProgressService] Project health analysis generation failed:', error?.code || error?.message);
      throw error;
    }

    return {
      confidence: content.confidence,
      riskLevel: PROJECT_HEALTH_RISK_LABELS[content.riskLevelKey] || 'غير محددة',
      riskLevelKey: content.riskLevelKey,
      healthRating: content.healthRating,
      bullets: content.bullets,
      earlyDays,
      matchPercentage: null
    };
  }
}

export const projectProgressService = new ProjectProgressService();
