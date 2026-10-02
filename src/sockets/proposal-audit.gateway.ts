import { Socket } from 'socket.io';
import { z } from 'zod';
import { aiFeatureUnavailablePayload } from '../services/ai/ai-feature-unavailable';
import { isSocketAiRateLimited, SOCKET_AI_RATE_LIMIT_MESSAGE } from '../utils/socket-ai-rate-limit';

// Proposal AI Audit is DISABLED: all AI must run exclusively through the
// WaseetAI service and no documented contract exists for proposal audits.
// The gateway keeps its auth / payload / ownership / rate-limit checks and the
// frontend contract (`ai_audit_progress` with status 'FAILED', never an
// `ai_audit_result`), but makes no AI call and fabricates nothing. The FAILED
// event additionally carries `code: AI_FEATURE_UNAVAILABLE`. The Angular
// handler (applay-request.ts) shows its honest "unavailable" empty state on
// FAILED, so the proposal can still be written and submitted normally.

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
  overallScore: number;
  profileMatch: number;
  messageClarity: number;
  priceCompetitiveness: number;
  timelineFeasibility: number;
  completeness: number;
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

const AI_AUDIT_UNAVAILABLE_MESSAGE =
  'التدقيق الذكي للعرض متوقف مؤقتاً حتى يكتمل ربطه بخدمة WaseetAI. يمكنك متابعة كتابة عرضك وتقديمه بشكل طبيعي.';

export class ProposalAuditGateway {
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

      // No AI call is made: the feature is paused until linked to WaseetAI.
      socket.emit('ai_audit_progress', {
        status: 'FAILED',
        ...aiFeatureUnavailablePayload(AI_AUDIT_UNAVAILABLE_MESSAGE)
      });
    });
  }
}

export const proposalAuditGateway = new ProposalAuditGateway();
export const registerProposalAuditGateway = (socket: Socket) => proposalAuditGateway.register(socket);
