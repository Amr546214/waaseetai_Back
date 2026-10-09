import { z } from 'zod';
import { prisma } from '../../config/db';
import { logger } from '../../config/logger';
import { llmClient, type LlmClient } from '../llm/llm.client';
import { buildPayload, type AllowRule } from '../llm/llm.payload';
import { GROUNDING_RULES_AR, basedOnSchema, countNumbers, inputsUsed } from './ai-feature.shared';
import { aiFailed, aiNotEnoughData, aiReady, parseStoredAiResult, type AiResult } from './ai-result';
import { CLIENT_PASSWORD_CHANGE_REQUEST_CATEGORY } from '../../utils/profile-request-categories';

// AI PRE-REVIEW of a governed profile change (a client's name / national id, a legacy email / phone / id request). It only SUMMARISES
// consistency signals for the human reviewer: the admin decision stays final, nothing is ever approved or rejected by it, and if the AI is
// unavailable the request simply waits for the team (aiReview.status = FAILED). The model never sees the old / new values themselves:
// only derived, non-identifying facts (lengths, format checks, similarity, counts of earlier requests).
//
// NEVER analysed: password changes (no content is ever sent) and document / KYC categories (no document content is sent to a model).

export const PROFILE_CHANGE_AI_FEATURE = 'profile-change-review';
const EXCLUDED_CATEGORIES = new Set<string>([CLIENT_PASSWORD_CHANGE_REQUEST_CATEGORY, 'DOCUMENTS', 'BANKING']);

export const PROFILE_CHANGE_ALLOW: AllowRule = {
  change: { category: 'string', fieldLabel: 'string', currentLength: 'number', requestedLength: 'number', identical: 'boolean', formatValid: 'boolean', similarityPercent: 'number', onlyCaseOrSpacing: 'boolean' },
  account: { accountAgeDays: 'number', earlierRequestsSameField: 'number', earlierRejectedSameField: 'number', otherPendingRequests: 'number', otpConfirmed: 'boolean' },
};

const PATHS = ['change.category', 'change.fieldLabel', 'change.currentLength', 'change.requestedLength', 'change.identical', 'change.formatValid', 'change.similarityPercent', 'change.onlyCaseOrSpacing',
  'account.accountAgeDays', 'account.earlierRequestsSameField', 'account.earlierRejectedSameField', 'account.otherPendingRequests', 'account.otpConfirmed'];

export const ProfileChangeReviewSchema = z.object({
  assessment: z.enum(['CONSISTENT', 'NEEDS_CLOSE_REVIEW']),
  summary: z.string().min(1).max(500),
  observations: z.array(z.object({ text: z.string().min(1).max(260), basedOn: basedOnSchema })).max(5),
});
export type ProfileChangeReviewOutput = z.infer<typeof ProfileChangeReviewSchema>;

export const PROFILE_CHANGE_SYSTEM = `أنت مساعد يلخّص لمراجع بشري مؤشرات اتساق طلب تعديل بيانات حساب، اعتماداً على مؤشرات JSON المرسلة فقط (لا تتلقى القيم الفعلية للبيانات).
المطلوب: assessment: CONSISTENT إذا لم تظهر مؤشرات تستدعي انتباهاً خاصاً، أو NEEDS_CLOSE_REVIEW إذا ظهر مؤشر يستدعي تدقيقاً أدق (تغيير كبير جداً، عدم صحة الصيغة، تكرار طلبات مرفوضة، طلب مطابق للقيمة الحالية).
اكتب summary قصيراً وobservations مبنية على المؤشرات. أنت لا تعتمد الطلب ولا ترفضه ولا تذكر قراراً: القرار للمراجع البشري وحده.
${GROUNDING_RULES_AR}`;

const norm = (s: string) => s.normalize('NFKC').trim();
function similarityPercent(a: string, b: string): number {
  const x = norm(a).toLowerCase(), y = norm(b).toLowerCase();
  if (!x && !y) return 100;
  const m = x.length, n = y.length;
  if (!m || !n) return 0;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (x[i - 1] === y[j - 1] ? 0 : 1));
    prev = cur;
  }
  return Math.round((1 - prev[n] / Math.max(m, n)) * 100);
}

function formatValid(fieldName: string, value: string): boolean | null {
  const v = norm(value);
  switch (fieldName) {
    case 'EMAIL': return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v);
    case 'PHONE_NUMBER': return /^\+?\d{8,15}$/.test(v.replace(/[\s()-]/g, ''));
    case 'NATIONAL_ID': case 'ID_NUMBER': return /^[12]\d{9}$/.test(v);
    case 'FULL_NAME': return v.length >= 4;
    default: return null;
  }
}

export interface ProfileChangeFeatures {
  change: { category: string; fieldLabel: string; currentLength: number; requestedLength: number; identical: boolean; formatValid: boolean | null; similarityPercent: number; onlyCaseOrSpacing: boolean };
  account: { accountAgeDays: number; earlierRequestsSameField: number; earlierRejectedSameField: number; otherPendingRequests: number; otpConfirmed: boolean };
}

export class ProfileChangeReviewService {
  constructor(private readonly llm: Pick<LlmClient, 'generateJson'> = llmClient) {}

  isEligible(category: string): boolean { return !EXCLUDED_CATEGORIES.has(category); }

  /** Derived, non-identifying features (the raw old / new values never leave this method). */
  async buildFeatures(request: { id: string; providerId: string; category: string; fieldName: string; fieldLabel: string; currentValue: string | null; requestedValue: string; otpVerifiedAt: Date | null }): Promise<ProfileChangeFeatures> {
    const [user, sameField, others] = await Promise.all([
      prisma.user.findUnique({ where: { id: request.providerId }, select: { createdAt: true } }),
      prisma.profileModificationRequest.findMany({ where: { providerId: request.providerId, fieldName: request.fieldName, id: { not: request.id } }, select: { status: true } }),
      prisma.profileModificationRequest.count({ where: { providerId: request.providerId, status: 'PENDING_HUMAN_REVIEW', id: { not: request.id } } }),
    ]);
    const current = request.currentValue ?? '';
    const requested = request.requestedValue ?? '';
    const sim = similarityPercent(current, requested);
    return {
      change: {
        category: request.category, fieldLabel: request.fieldLabel, currentLength: norm(current).length, requestedLength: norm(requested).length,
        identical: norm(current) === norm(requested), formatValid: formatValid(request.fieldName, requested), similarityPercent: sim,
        onlyCaseOrSpacing: norm(current).replace(/\s+/g, '').toLowerCase() === norm(requested).replace(/\s+/g, '').toLowerCase(),
      },
      account: {
        accountAgeDays: user?.createdAt ? Math.max(0, Math.floor((Date.now() - new Date(user.createdAt).getTime()) / 86_400_000)) : 0,
        earlierRequestsSameField: sameField.length, earlierRejectedSameField: sameField.filter(r => r.status === 'REJECTED').length,
        otherPendingRequests: others, otpConfirmed: !!request.otpVerifiedAt,
      },
    };
  }

  /** Produces the AI pre-review (never throws): READY with a summary, FAILED when the model is unavailable, NOT_ENOUGH_DATA when there is nothing to assess. */
  async analyse(userId: string, features: ProfileChangeFeatures): Promise<AiResult<{ assessment: string; observations: { text: string; basedOn: string[] }[] }>> {
    const payload = buildPayload(features, PROFILE_CHANGE_ALLOW) as any;
    const used = inputsUsed(payload, PATHS);
    if (used.length < 4) return aiNotEnoughData();
    try {
      const res = await this.llm.generateJson<ProfileChangeReviewOutput>({
        feature: PROFILE_CHANGE_AI_FEATURE, userId, schema: ProfileChangeReviewSchema, system: PROFILE_CHANGE_SYSTEM, input: payload,
        timeoutMs: 20_000, maxOutputTokens: 700, cache: false,
        grounding: { basedOn: ['observations[].basedOn'], freeText: ['summary', 'observations[].text'], allowedNumbers: [...countNumbers(payload), 0, 100] },
      });
      return aiReady({
        source: 'GEMINI', summary: res.data.summary, confidence: null, score: null,
        recommendation: res.data.assessment === 'CONSISTENT' ? 'لم تظهر مؤشرات تستدعي انتباهاً خاصاً (فحص أولي، القرار للمراجع).' : 'يُنصح بتدقيق أدق قبل القرار (فحص أولي، القرار للمراجع).',
        details: { assessment: res.data.assessment, observations: res.data.observations },
      });
    } catch (error) {
      logger.warn(`[ProfileChangeReview] AI pre-review unavailable (${(error as { code?: string })?.code ?? 'error'}); the request waits for the team`);
      return aiFailed('GEMINI');
    }
  }

  /** Runs the pre-review for a stored request and writes it back (metadata.aiReview + the existing aiAuditStatus / aiRecommendation columns). Never throws. */
  async reviewStoredRequest(requestId: string): Promise<AiResult | null> {
    try {
      const request = await prisma.profileModificationRequest.findUnique({ where: { id: requestId } });
      if (!request || request.status !== 'PENDING_HUMAN_REVIEW' || !this.isEligible(request.category)) return null;
      const features = await this.buildFeatures(request as any);
      const result = await this.analyse(request.providerId, features);
      const meta = (request.metadata && typeof request.metadata === 'object' && !Array.isArray(request.metadata) ? request.metadata : {}) as Record<string, unknown>;
      const ready = result.status === 'READY';
      const needsClose = ready && (result.details as any)?.assessment === 'NEEDS_CLOSE_REVIEW';
      await prisma.profileModificationRequest.update({
        where: { id: requestId },
        data: {
          metadata: { ...meta, aiReview: result } as any,
          // the existing columns carry the pre-review ONLY when it really ran; the human decision (status) is untouched
          aiAuditStatus: ready ? (needsClose ? 'NEEDS_HUMAN_REVIEW' : 'PASSED') : null,
          aiRecommendation: ready ? result.recommendation : null,
          aiConfidence: null,
        },
      });
      return result;
    } catch (error) {
      logger.error(`[ProfileChangeReview] could not store the pre-review (requestId=${requestId})`, error);
      return null;
    }
  }

  /** Fire-and-forget: the user flow never waits for the model. */
  schedule(requestId: string): void {
    void this.reviewStoredRequest(requestId);
  }
}

export const profileChangeReviewService = new ProfileChangeReviewService();

/** The safe projection of a stored pre-review for any list (no raw metadata): null when none exists. */
export function publicAiReview(metadata: unknown): { status: string; source: string; summary: string | null; recommendation: string | null; generatedAt: string | null; observations: string[] } | null {
  const m = metadata && typeof metadata === 'object' && !Array.isArray(metadata) ? (metadata as Record<string, unknown>) : null;
  const stored = parseStoredAiResult(m?.aiReview);
  if (!stored) return null;
  const obs = ((stored.details as any)?.observations ?? []) as { text?: unknown }[];
  return {
    status: stored.status, source: stored.source, summary: stored.summary, recommendation: stored.recommendation, generatedAt: stored.generatedAt,
    observations: stored.status === 'READY' ? obs.map(o => (typeof o?.text === 'string' ? o.text : '')).filter(Boolean) : [],
  };
}

/**
 * A request row for any list: no raw metadata, an `aiReview` projection, and the legacy aiAuditStatus / aiConfidence / aiRecommendation
 * columns ONLY when a real stored pre-review backs them (older rows carry values written before any AI existed there: never shown).
 */
export function withHonestAiReview<T extends Record<string, any>>(row: T): Omit<T, 'metadata'> & { aiReview: ReturnType<typeof publicAiReview> } {
  const { metadata, ...rest } = row;
  const aiReview = publicAiReview(metadata);
  const real = aiReview?.status === 'READY';
  return { ...rest, ...('aiAuditStatus' in rest ? { aiAuditStatus: real ? rest.aiAuditStatus : null } : {}), ...('aiConfidence' in rest ? { aiConfidence: null } : {}), ...('aiRecommendation' in rest ? { aiRecommendation: real ? rest.aiRecommendation : null } : {}), aiReview } as any;
}
