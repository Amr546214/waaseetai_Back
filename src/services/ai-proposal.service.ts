import { AppError } from '../utils/app-error';
import { prisma } from '../utils/prisma.client';
import { waseetAiClient } from './ai/waseet-ai/waseet-ai.client';
import type { EnrichProposalRequest } from './ai/waseet-ai/waseet-ai.types';
import { normalizeWaseetAiError } from './ai/waseet-ai/waseet-ai.errors';

export interface AiProposalFeedback {
  suggestedTitle: string;
  suggestedMessage: string;
  suggestedOutputs?: string;
  suggestedTotalPrice?: number | null;
  suggestedMilestones?: Array<{ name: string; desc: string; days: number; pct: number }>;
  qualityScore: number;
  qualityTag: string;
  suggestedAdvantages: string[];
}

export interface ProposalEvaluationInput {
  projectId: string;
  title: string;
  message: string;
  totalPrice: number;
  deliveryDays: number;
  milestones?: Array<{ stepOrder: number; title: string; description: string; days: number; percentage: number; amount: number }>;
}

export interface ProposalEvaluation {
  qualityScore: number;
  qualityTag: string;
  summary: string;
}

const PROPOSAL_AI_CURRENCY = 'USD';

const UNAVAILABLE_MESSAGE = 'تعذر تحليل العرض بالذكاء الاصطناعي حالياً. لم يتم تغيير عرضك، يمكنك المتابعة يدوياً.';

function ensureArabicProposalSummary(rawSummary: string, score: number, milestonesCount: number): string {
  const trimmed = rawSummary.trim();
  const hasArabic = /[\u0600-\u06FF]/.test(trimmed);
  if (hasArabic) return trimmed;
  if (score >= 80) {
    return `عرض فني قوي ومفصل (درجة الجودة ${score}%) يتضمن خطة عمل واضحة${milestonesCount > 0 ? ` موزعة على ${milestonesCount} مراحل تسليم` : ''} مع تحديد دقيق للمخرجات والمدة الزمنية.`;
  }
  if (score >= 60) {
    return `عرض فني جيد (درجة الجودة ${score}%) يغطي المتطلبات الأساسية للمشروع، ويُنصح بإضافة مزيد من التفاصيل حول منهجية التنفيذ والمخرجات المتوقعة لكل مرحلة.`;
  }
  return `عرض فني مبدئي (درجة الجودة ${score}%) يحتاج إلى توضيح أعمق لخطة العمل وتفصيل المخرجات الفنية ومراحل التسليم لرفع فرص قبوله.`;
}

class AiProposalService {
  public async evaluate(input: ProposalEvaluationInput): Promise<ProposalEvaluation> {
    const projectId = typeof input?.projectId === 'string' ? input.projectId.trim() : '';
    const title = typeof input?.title === 'string' ? input.title.trim() : '';
    const message = typeof input?.message === 'string' ? input.message.trim() : '';
    if (!projectId) throw new AppError('معرف المشروع (projectId) مطلوب', 400);
    if (!title || !message) throw new AppError('عنوان العرض ونصه مطلوبان للتحليل', 400);
    if (!Number.isFinite(input.totalPrice) || !Number.isFinite(input.deliveryDays)) {
      throw new AppError('سعر العرض ومدة التنفيذ يجب أن يكونا أرقاماً صحيحة', 400);
    }
    const body: EnrichProposalRequest = { projectId, title, message, totalPrice: input.totalPrice, deliveryDays: input.deliveryDays };
    if (Array.isArray(input.milestones) && input.milestones.length > 0) {
      body.milestones = input.milestones.map((m) => ({
        stepOrder: m.stepOrder, title: m.title, description: m.description,
        days: m.days, percentage: m.percentage, amount: m.amount
      }));
    }

    let raw;
    try {
      raw = await waseetAiClient.enrichProposal(body);
    } catch (error) {
      const e = normalizeWaseetAiError(error);
      console.error(`[AiProposal] WaseetAI proposal evaluation failed code=${e.code} status=${e.status ?? '-'} requestId=${e.requestId ?? '-'}`);
      throw new AppError(UNAVAILABLE_MESSAGE, 503);
    }

    const qualityTag = typeof raw?.aiQualityTag === 'string' ? raw.aiQualityTag.trim() : '';
    const rawSummary = typeof raw?.aiFeedback?.summary === 'string' ? raw.aiFeedback.summary.trim() : '';
    const score = raw?.qualityScore ?? raw?.aiMatchScore;
    if (typeof score !== 'number' || !Number.isFinite(score) || score < 0 || score > 100 || !qualityTag || !rawSummary) {
      throw new AppError(UNAVAILABLE_MESSAGE, 503);
    }
    const summary = ensureArabicProposalSummary(rawSummary, score, input.milestones?.length ?? 0);
    return { qualityScore: score, qualityTag, summary };
  }

  public async evaluateAndSuggestProposal(
    projectId?: string,
    currentTitle?: string,
    currentMessage?: string,
    _advantages: string[] = []
  ): Promise<AiProposalFeedback> {
    const id = typeof projectId === 'string' ? projectId.trim() : '';
    const title = typeof currentTitle === 'string' ? currentTitle.trim() : '';
    const message = typeof currentMessage === 'string' ? currentMessage.trim() : '';
    if (!id) throw new AppError('معرف المشروع (projectId) مطلوب', 400);

    let projectContext: {
      title?: string;
      description?: string;
      requirements?: string[];
      budgetMin?: number;
      budgetMax?: number;
      deliveryDays?: number;
    } | undefined;

    try {
      const [project, clientRequest] = await Promise.all([
        prisma.project.findUnique({ where: { id } }),
        prisma.clientRequest.findUnique({ where: { id } })
      ]);
      const pTitle = project?.title || clientRequest?.title;
      const pDesc = project?.description || clientRequest?.description;
      const pReqs = Array.isArray(project?.requirements) && project.requirements.length > 0
        ? project.requirements
        : (Array.isArray(clientRequest?.requiredSkills) ? clientRequest.requiredSkills : []);
      const bMin = project?.budgetMin ?? clientRequest?.minBudget;
      const bMax = project?.budgetMax ?? clientRequest?.maxBudget;
      const dDays = project?.deliveryDays ?? clientRequest?.expectedDurationDays;

      if (pTitle || pDesc) {
        projectContext = {
          ...(pTitle ? { title: pTitle } : {}),
          ...(pDesc ? { description: pDesc } : {}),
          ...(pReqs.length > 0 ? { requirements: pReqs } : {}),
          ...(typeof bMin === 'number' && Number.isFinite(bMin) ? { budgetMin: bMin } : {}),
          ...(typeof bMax === 'number' && Number.isFinite(bMax) ? { budgetMax: bMax } : {}),
          ...(typeof dDays === 'number' && Number.isFinite(dDays) && dDays > 0 ? { deliveryDays: dDays } : {})
        };
      }
    } catch {
      // Non-fatal: proceed even if project lookup fails
    }

    if (!title && !message && !projectContext?.title && !projectContext?.description) {
      throw new AppError('تعذر العثور على تفاصيل المشروع لصياغة العرض؛ يرجى كتابة عنوان أو نص العرض أولاً', 400);
    }

    let raw;
    try {
      raw = await waseetAiClient.suggestProposal({
        projectId: id,
        currentTitle: title,
        currentMessage: message,
        currency: PROPOSAL_AI_CURRENCY,
        ...(projectContext ? { project: projectContext } : {})
      });
    } catch (error) {
      const e = normalizeWaseetAiError(error);
      console.error(`[AiProposal] WaseetAI proposal suggestion failed code=${e.code} status=${e.status ?? '-'} requestId=${e.requestId ?? '-'}`);
      throw new AppError(UNAVAILABLE_MESSAGE, 503);
    }

    const suggestedTitle = typeof raw?.suggestedTitle === 'string' ? raw.suggestedTitle.trim() : '';
    const suggestedMessage = typeof raw?.suggestedMessage === 'string' ? raw.suggestedMessage.trim() : '';
    const qualityTag = typeof raw?.qualityTag === 'string' ? raw.qualityTag.trim() : '';
    if (!suggestedTitle || !suggestedMessage || !qualityTag || typeof raw.qualityScore !== 'number' || !Number.isFinite(raw.qualityScore)) {
      throw new AppError(UNAVAILABLE_MESSAGE, 503);
    }

    return {
      suggestedTitle,
      suggestedMessage,
      ...(typeof raw.suggestedOutputs === 'string' && raw.suggestedOutputs.trim() ? { suggestedOutputs: raw.suggestedOutputs.trim() } : {}),
      ...(typeof raw.suggestedTotalPrice === 'number' && Number.isFinite(raw.suggestedTotalPrice) && raw.suggestedTotalPrice > 0 ? { suggestedTotalPrice: raw.suggestedTotalPrice } : {}),
      ...(Array.isArray(raw.suggestedMilestones) && raw.suggestedMilestones.length > 0 ? { suggestedMilestones: raw.suggestedMilestones } : {}),
      qualityScore: raw.qualityScore,
      qualityTag,
      suggestedAdvantages: Array.isArray(raw.suggestedAdvantages)
        ? raw.suggestedAdvantages.filter((a): a is string => typeof a === 'string' && a.trim().length > 0).map((a) => a.trim())
        : []
    };
  }
}

export const aiProposalService = new AiProposalService();
export default aiProposalService;
