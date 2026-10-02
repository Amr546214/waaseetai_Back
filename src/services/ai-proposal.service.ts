import { AppError } from '../utils/app-error';
import { waseetAiClient } from './ai/waseet-ai/waseet-ai.client';
import type { EnrichProposalRequest } from './ai/waseet-ai/waseet-ai.types';
import { normalizeWaseetAiError } from './ai/waseet-ai/waseet-ai.errors';

// Proposal AI feedback — served exclusively by WaseetAI
// (POST /v1/ai/proposals/suggest via waseetAiClient.suggestProposal).
//
// VERIFIED LIMITATION: the WaseetAI service cannot see Waseet's projects
// (`projectId` is an opaque string to it). Its `priceAudit` (recommended
// price range / price tag / justification) is therefore NOT grounded in the
// real project budget. It is deliberately DROPPED here: never returned to
// the browser, never stored, never shown as a price recommendation. Only the
// title / message / advantages / quality fields are mapped.
//
// The request contract has no field for the draft's advantages, so they are
// not sent.

export interface AiProposalFeedback {
  suggestedTitle: string;
  suggestedMessage: string;
  qualityScore: number;
  // Free-form tag as returned by the service (not an enum we control).
  qualityTag: string;
  // Canonical application field name — the frontend reads `suggestedAdvantages`.
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

// Evaluation of a SUBMITTED proposal (POST /v1/ai/proposals/enrich).
// LIMITATION: WaseetAI cannot see Waseet's projects, so `qualityScore` is a
// PROPOSAL-QUALITY score (not a match against the real project) and the
// returned price tag is deliberately dropped (not relative to the real budget).
export interface ProposalEvaluation {
  qualityScore: number;
  qualityTag: string;
  summary: string;
}

const PROPOSAL_AI_CURRENCY = 'USD';

const UNAVAILABLE_MESSAGE = 'تعذر تحليل العرض بالذكاء الاصطناعي حالياً. لم يتم تغيير عرضك، يمكنك المتابعة يدوياً.';

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
    const summary = typeof raw?.aiFeedback?.summary === 'string' ? raw.aiFeedback.summary.trim() : '';
    const score = raw?.aiMatchScore;
    if (typeof score !== 'number' || !Number.isFinite(score) || score < 0 || score > 100 || !qualityTag || !summary) {
      throw new AppError(UNAVAILABLE_MESSAGE, 503);
    }
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
    if (!title && !message) throw new AppError('اكتب عنوان العرض أو نصه أولاً ليتم تحليله', 400);

    let raw;
    try {
      raw = await waseetAiClient.suggestProposal({
        projectId: id,
        currentTitle: title,
        currentMessage: message,
        currency: PROPOSAL_AI_CURRENCY
      });
    } catch (error) {
      // Code/status only — upstream text and credentials are never surfaced.
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
      qualityScore: raw.qualityScore,
      qualityTag,
      suggestedAdvantages: Array.isArray(raw.suggestedAdvantages)
        ? raw.suggestedAdvantages.filter((a): a is string => typeof a === 'string' && a.trim().length > 0).map((a) => a.trim())
        : []
      // `raw.priceAudit` intentionally omitted — see the limitation above.
    };
  }
}

export const aiProposalService = new AiProposalService();
export default aiProposalService;
