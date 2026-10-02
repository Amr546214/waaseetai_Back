import { Socket } from 'socket.io';
import { z } from 'zod';
import { aiProposalService, type ProposalEvaluation, type ProposalEvaluationInput } from '../services/ai-proposal.service';
import { AppError } from '../utils/app-error';
import { isSocketAiRateLimited, SOCKET_AI_RATE_LIMIT_MESSAGE } from '../utils/socket-ai-rate-limit';

// Proposal quality review. The only AI input is WaseetAI `proposals/enrich`
// (via aiProposalService.evaluate): a PROPOSAL-QUALITY score, tag and summary
// computed from the proposal's own title, message, price and duration. The
// service cannot see the project, so nothing here claims fit with the project,
// a fair price/duration, or an acceptance probability — those fields of the
// frontend contract are returned as "غير متاح" / "غير مدعوم" (or null).
// On any failure only `ai_audit_progress` with status FAILED is emitted;
// an `ai_audit_result` is never fabricated.

// ==========================================
// 1. DATA MODELS & ZOD VALIDATION
// ==========================================

export interface ProfileAuditItem {
  title: string;
  subtitle: string;
  status: 'EXCELLENT' | 'GOOD' | 'WARNING';
  badge: string;
}

export interface TriPartyComparison {
  client: { budget: string; duration: string; milestones: string };
  provider: { budget: string; duration: string; milestones: string };
  aiRecommendation: { budget: string; duration: string; milestones: string };
}

export interface FinalMetrics {
  /** WaseetAI proposal-quality score (0-100). */
  overallScore: number;
  // Not produced by WaseetAI — always null.
  profileMatch: number | null;
  messageClarity: number | null;
  priceCompetitiveness: number | null;
  timelineFeasibility: number | null;
  completeness: number | null;
}

export interface AcceptanceOdds {
  statusText: string;
  description: string;
  topPercentage: string;
}

export interface AiProposalAuditResult {
  profileAudit: ProfileAuditItem[];
  triPartyComparison: TriPartyComparison;
  triPartyNote: string;
  finalMetrics: FinalMetrics;
  acceptanceOdds: AcceptanceOdds;
}

const triggerAiAuditSchema = z.object({
  projectId: z.string().min(1),
  providerId: z.string().min(1),
  proposalDraft: z.object({
    title: z.string(),
    message: z.string(),
    price: z.number().positive(),
    durationDays: z.number().positive(),
    milestonesCount: z.number().int().nonnegative(),
    selectedPortfolioIds: z.array(z.string()).optional().default([])
  })
});

export type TriggerAiAuditPayload = z.infer<typeof triggerAiAuditSchema>;

// ==========================================
// 2. PROPOSAL AUDIT GATEWAY
// ==========================================

const UNSUPPORTED = 'غير مدعوم';
const UNAVAILABLE = 'غير متاح';
const QUALITY_SCOPE_NOTE =
  'يقيّم هذا الفحص نص العرض وخطته وسعره كما كُتبت فقط. لا يقيس توافقه مع المشروع ولا عدالة السعر مقارنة بميزانية العميل.';
const PROGRESS_MESSAGE = 'جاري مراجعة جودة العرض...';
const GENERIC_FAILURE_MESSAGE = 'تعذر إكمال مراجعة جودة العرض حالياً. يمكنك متابعة كتابة عرضك وتقديمه بشكل طبيعي.';

/** Maps a WaseetAI proposal evaluation to the frontend contract without inventing anything. */
export function buildQualityAuditResult(
  draft: TriggerAiAuditPayload['proposalDraft'],
  evaluation: ProposalEvaluation
): AiProposalAuditResult {
  const score = evaluation.qualityScore;
  return {
    profileAudit: [{
      title: 'مراجعة جودة العرض',
      subtitle: evaluation.summary,
      status: score >= 80 ? 'EXCELLENT' : score >= 50 ? 'GOOD' : 'WARNING',
      badge: evaluation.qualityTag
    }],
    triPartyComparison: {
      client: { budget: UNAVAILABLE, duration: UNAVAILABLE, milestones: UNAVAILABLE },
      provider: { budget: `${draft.price} $`, duration: `${draft.durationDays} يوم`, milestones: `${draft.milestonesCount} مرحلة` },
      aiRecommendation: { budget: UNSUPPORTED, duration: UNSUPPORTED, milestones: UNSUPPORTED }
    },
    triPartyNote: QUALITY_SCOPE_NOTE,
    finalMetrics: {
      overallScore: score,
      profileMatch: null,
      messageClarity: null,
      priceCompetitiveness: null,
      timelineFeasibility: null,
      completeness: null
    },
    acceptanceOdds: { statusText: UNSUPPORTED, description: UNSUPPORTED, topPercentage: UNSUPPORTED }
  };
}

type EvaluateFn = (input: ProposalEvaluationInput) => Promise<ProposalEvaluation>;

export class ProposalAuditGateway {
  constructor(private readonly evaluate: EvaluateFn = (input) => aiProposalService.evaluate(input)) {}

  /**
   * Registers WebSocket event listeners for real-time AI Proposal auditing
   */
  public register(socket: Socket): void {
    socket.on('trigger_ai_audit', async (rawPayload: any) => {
      console.log(`[ProposalAuditGateway] Received trigger_ai_audit event from socket ${socket.id}`);

      const fail = (message: string) => {
        socket.emit('ai_audit_progress', { status: 'FAILED', message });
      };

      // ── Pre-flight: auth, ownership, rate limit, provider config, payload ──
      const userId = (socket as any).userId;
      if (!userId) {
        fail('يجب تسجيل الدخول لاستخدام التدقيق الذكي للعرض.');
        return;
      }

      const parseResult = triggerAiAuditSchema.safeParse(rawPayload);
      if (!parseResult.success) {
        console.warn('[ProposalAuditGateway] Invalid payload structure received:', parseResult.error.format());
        fail('بيانات طلب التدقيق غير صالحة.');
        return;
      }
      const payload = parseResult.data;

      // Ownership: a socket may only ever request an audit against its own
      // provider identity — never another provider's profile data.
      if (payload.providerId !== userId) {
        fail('لا يمكنك طلب تدقيق ذكي لملف مقدم خدمة آخر.');
        return;
      }

      if (isSocketAiRateLimited(userId)) {
        fail(SOCKET_AI_RATE_LIMIT_MESSAGE);
        return;
      }

      socket.emit('ai_audit_progress', { status: 'IN_PROGRESS', message: PROGRESS_MESSAGE });

      let evaluation: ProposalEvaluation;
      try {
        evaluation = await this.evaluate({
          projectId: payload.projectId,
          title: payload.proposalDraft.title,
          message: payload.proposalDraft.message,
          totalPrice: payload.proposalDraft.price,
          deliveryDays: payload.proposalDraft.durationDays
        });
      } catch (error) {
        // AppError messages are fixed, user-safe Arabic strings; anything else is generic.
        fail(error instanceof AppError ? error.message : GENERIC_FAILURE_MESSAGE);
        return;
      }

      socket.emit('ai_audit_result', buildQualityAuditResult(payload.proposalDraft, evaluation));
      socket.emit('ai_audit_progress', { status: 'COMPLETED', message: 'اكتملت مراجعة جودة العرض' });
    });
  }
}

export const proposalAuditGateway = new ProposalAuditGateway();
export const registerProposalAuditGateway = (socket: Socket) => proposalAuditGateway.register(socket);
