import { Socket } from 'socket.io';
import { prisma } from '../utils/prisma.client';
import { z } from 'zod';
import { geminiClient } from '../services/ai/gemini/gemini.client';
import { isSocketAiRateLimited, SOCKET_AI_RATE_LIMIT_MESSAGE } from '../utils/socket-ai-rate-limit';

// F5 — Proposal AI Audit, migrated to the shared Gemini foundation.
//
// Fallback decision (Batch: F5 proposal audit): the previous implementation
// ALWAYS eventually emitted `ai_audit_progress{status:'COMPLETED'}` +
// `ai_audit_result` with a fully fabricated, positive-looking audit
// (fake scores, fake "profile match" text, fake acceptance odds) whenever
// the payload was invalid, the project/provider record was missing, OpenAI
// was unconfigured, or the OpenAI call itself failed — there was no way for
// the frontend to distinguish a real audit from a fabricated one, since both
// arrived via the identical `ai_audit_result` event with `status:'COMPLETED'`.
// The frontend's OWN `getUnavailableAudit()` (zero scores, explicit "no
// substitute evaluation or fake scores were created") already existed as a
// 4.5s client-side timeout fallback, but was effectively unreachable since
// the backend always answered before that timer fired.
//
// Fix: the fabricated fallback generator is removed entirely. Every failure
// path now emits a NEW `ai_audit_progress` status value, `'FAILED'`, and
// NEVER emits `ai_audit_result` — this is the smallest possible additive
// contract change (existing status values/messages are unchanged; `'FAILED'`
// is simply a value the frontend didn't previously receive) and lets the
// frontend react immediately with its already-existing honest empty state
// instead of waiting out the old 4.5s safety timeout. See
// applay-request.ts's `ai_audit_progress` handler for the one corresponding
// frontend line.
//
// Progress labels: FETCHING_DATA / ANALYZING_PITCH / CALCULATING_TRI_PARTY
// are pre-existing, application-owned stage labels (not raw provider
// streaming/percentages — there were never any numeric progress percentages
// in this contract to begin with) and are preserved in their original order
// and wording.

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

const BUDGET_DURATION_MILESTONES_SCHEMA = {
  type: 'object',
  properties: {
    budget: { type: 'string' },
    duration: { type: 'string' },
    milestones: { type: 'string' }
  },
  required: ['budget', 'duration', 'milestones']
};

const AI_PROPOSAL_AUDIT_SCHEMA = {
  type: 'object',
  properties: {
    profileAudit: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          title: { type: 'string' },
          subtitle: { type: 'string' },
          status: { type: 'string', enum: ['EXCELLENT', 'GOOD', 'WARNING'] },
          badge: { type: 'string' }
        },
        required: ['title', 'subtitle', 'status', 'badge']
      },
      description: 'exactly 4 distinct audit criteria items assessing Experience, Specialty match, Tone & clarity, and Portfolio proof'
    },
    triPartyComparison: {
      type: 'object',
      properties: {
        client: BUDGET_DURATION_MILESTONES_SCHEMA,
        provider: BUDGET_DURATION_MILESTONES_SCHEMA,
        aiRecommendation: BUDGET_DURATION_MILESTONES_SCHEMA
      },
      required: ['client', 'provider', 'aiRecommendation']
    },
    triPartyNote: { type: 'string' },
    finalMetrics: {
      type: 'object',
      properties: {
        overallScore: { type: 'number', description: '0 to 100' },
        profileMatch: { type: 'number', description: '0 to 100' },
        messageClarity: { type: 'number', description: '0 to 100' },
        priceCompetitiveness: { type: 'number', description: '0 to 100' },
        timelineFeasibility: { type: 'number', description: '0 to 100' },
        completeness: { type: 'number', description: '0 to 100' }
      },
      required: ['overallScore', 'profileMatch', 'messageClarity', 'priceCompetitiveness', 'timelineFeasibility', 'completeness']
    },
    acceptanceOdds: {
      type: 'object',
      properties: {
        statusText: { type: 'string' },
        description: { type: 'string' },
        topPercentage: { type: 'string' }
      },
      required: ['statusText', 'description', 'topPercentage']
    }
  },
  required: ['profileAudit', 'triPartyComparison', 'triPartyNote', 'finalMetrics', 'acceptanceOdds']
};

const isNonEmptyString = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0;
const isBoundedScore = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 100;

function isValidBudgetDurationMilestones(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return isNonEmptyString(v.budget) && isNonEmptyString(v.duration) && isNonEmptyString(v.milestones);
}

// Rejects anything that doesn't genuinely satisfy the AiProposalAuditResult
// contract — an empty profileAudit array, an unrecognized status enum, an
// out-of-range score, or a malformed nested object are all invalid, never
// silently patched into a passable-looking audit.
function isValidAiProposalAuditResult(value: unknown): value is AiProposalAuditResult {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;

  if (!Array.isArray(v.profileAudit) || v.profileAudit.length === 0) return false;
  const profileAuditValid = v.profileAudit.every((item) => {
    if (!item || typeof item !== 'object') return false;
    const entry = item as Record<string, unknown>;
    return (
      isNonEmptyString(entry.title) &&
      isNonEmptyString(entry.subtitle) &&
      (entry.status === 'EXCELLENT' || entry.status === 'GOOD' || entry.status === 'WARNING') &&
      isNonEmptyString(entry.badge)
    );
  });
  if (!profileAuditValid) return false;

  const triParty = v.triPartyComparison as Record<string, unknown> | undefined;
  if (!triParty || typeof triParty !== 'object') return false;
  if (!isValidBudgetDurationMilestones(triParty.client)) return false;
  if (!isValidBudgetDurationMilestones(triParty.provider)) return false;
  if (!isValidBudgetDurationMilestones(triParty.aiRecommendation)) return false;

  if (!isNonEmptyString(v.triPartyNote)) return false;

  const metrics = v.finalMetrics as Record<string, unknown> | undefined;
  if (!metrics || typeof metrics !== 'object') return false;
  if (!isBoundedScore(metrics.overallScore)) return false;
  if (!isBoundedScore(metrics.profileMatch)) return false;
  if (!isBoundedScore(metrics.messageClarity)) return false;
  if (!isBoundedScore(metrics.priceCompetitiveness)) return false;
  if (!isBoundedScore(metrics.timelineFeasibility)) return false;
  if (!isBoundedScore(metrics.completeness)) return false;

  const odds = v.acceptanceOdds as Record<string, unknown> | undefined;
  if (!odds || typeof odds !== 'object') return false;
  if (!isNonEmptyString(odds.statusText)) return false;
  if (!isNonEmptyString(odds.description)) return false;
  if (!isNonEmptyString(odds.topPercentage)) return false;

  return true;
}

// ==========================================
// 2. PROPOSAL AUDIT GATEWAY
// ==========================================

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

      if (!geminiClient.isConfigured()) {
        fail('خدمة الذكاء الاصطناعي غير مهيأة حالياً. لم يتم إنشاء أي نتيجة بديلة.');
        return;
      }

      const abortController = new AbortController();
      const onDisconnect = () => abortController.abort();
      socket.once('disconnect', onDisconnect);

      try {
        socket.emit('ai_audit_progress', {
          status: 'FETCHING_DATA',
          message: 'جاري استدعاء بيانات المشروع والملف المهني...'
        });

        const [project, provider] = await Promise.all([
          prisma.project.findUnique({
            where: { id: payload.projectId },
            select: {
              title: true,
              description: true,
              specialty: true,
              subSpecialties: true,
              budgetMin: true,
              budgetMax: true,
              budgetFixed: true,
              deliveryDays: true,
              requirements: true
            }
          }),
          prisma.user.findUnique({
            where: { id: payload.providerId },
            select: {
              firstName: true,
              lastName: true,
              providerProfile: {
                select: {
                  yearsOfExperience: true,
                  rating: true,
                  headline: true,
                  bio: true,
                  skills: { select: { name: true } },
                  portfolioItems: { select: { id: true, title: true } }
                }
              },
              _count: {
                select: { providerProjects: true }
              }
            }
          })
        ]);

        if (!project || !provider) {
          fail('تعذر العثور على بيانات المشروع أو ملف مقدم الخدمة اللازمة لإجراء التدقيق.');
          return;
        }

        socket.emit('ai_audit_progress', {
          status: 'ANALYZING_PITCH',
          message: 'جاري تحليل نص العرض ومقارنة الخبرات...'
        });
        socket.emit('ai_audit_progress', {
          status: 'CALCULATING_TRI_PARTY',
          message: 'جاري حساب المقارنة الثلاثية ومؤشر احتمالية القبول...'
        });

        const auditResult = await this.executeGeminiAudit(payload.proposalDraft, project, provider, abortController.signal);

        socket.emit('ai_audit_progress', {
          status: 'COMPLETED',
          message: 'تم إنجاز التدقيق الذكي بنجاح'
        });
        socket.emit('ai_audit_result', auditResult);
      } catch (error: any) {
        // Honest failure — no fabricated scores, strengths, recommendations,
        // or positive-looking audit result of any kind.
        console.error('[ProposalAuditGateway] Gemini audit failed:', error?.code || error?.message);
        fail('تعذر إجراء التدقيق الذكي للعرض حالياً، يرجى المحاولة لاحقاً.');
      } finally {
        socket.off('disconnect', onDisconnect);
      }
    });
  }

  /**
   * Executes the Gemini structured-output audit request.
   */
  private async executeGeminiAudit(
    draft: TriggerAiAuditPayload['proposalDraft'],
    project: any,
    provider: any,
    signal: AbortSignal
  ): Promise<AiProposalAuditResult> {
    const profile = provider.providerProfile || {};
    const expYears = profile.yearsOfExperience || 4;
    const completedCount = provider._count?.providerProjects || 15;
    const skillsList = (profile.skills || []).map((s: any) => s.name).join(', ');

    const budgetClientMin = project.budgetMin ?? project.budgetFixed ?? 5000;
    const budgetClientMax = project.budgetMax ?? project.budgetFixed ?? 5000;

    const systemPrompt = `You are the Waseet AI Principal Proposal Auditor and Market Strategist.
Your mission is to perform a real-time, comprehensive audit of a freelancer's proposal draft against the client's RFP requirements and the freelancer's actual profile experience.
You MUST analyze the pitch tone, pricing competitiveness, delivery timeframe, and portfolio proof.
You MUST return strictly valid JSON conforming exactly to the required output schema, in flawless, professional Arabic. Do NOT wrap in Markdown or add external prose.`;

    const userPrompt = `
Analyze the following parameters and output the exact JSON structure:

[Target Project Parameters]
- Title: ${project.title || 'مشروع تطوير'}
- Specialty: ${project.specialty || 'تصميم وتطوير'}
- Requirements: ${JSON.stringify(project.requirements || [])}
- Client Target Duration: ${project.deliveryDays || 30} days
- Client Target Budget: ${budgetClientMin} - ${budgetClientMax} USD

[Provider Profile Specs]
- Name: ${provider.firstName} ${provider.lastName}
- Headline: ${profile.headline || 'مستقل محترف'}
- Years of Experience: ${expYears} years
- Completed Projects: ${completedCount}
- Verified Skills: ${skillsList}
- Portfolio Items Count: ${(profile.portfolioItems || []).length}

[Submitted Proposal Draft]
- Title: ${draft.title}
- Pitch Message: ${draft.message}
- Proposed Price: ${draft.price} USD
- Proposed Duration: ${draft.durationDays} days
- Milestones Count: ${draft.milestonesCount}
- Attached Portfolio IDs Count: ${(draft.selectedPortfolioIds || []).length}

Output exactly this JSON structure (keep status strictly one of "EXCELLENT", "GOOD", "WARNING"):
{
  "profileAudit": [
    {
      "title": "Title of check in Arabic (e.g. الخبرة المدمجة تتوافق مع ملفك)",
      "subtitle": "Detailed analytical observation in Arabic citing real numbers from profile",
      "status": "EXCELLENT",
      "badge": "ممتاز"
    },
    ... (provide exactly 4 distinct audit criteria items assessing Experience, Specialty match, Tone & clarity, and Portfolio proof)
  ],
  "triPartyComparison": {
    "client": { "budget": "string in USD (e.g. $5,000-$5,000)", "duration": "string in days (e.g. 30 يوم)", "milestones": "string (e.g. غير محدد)" },
    "provider": { "budget": "string in USD", "duration": "string in days", "milestones": "string (e.g. 2 مرحلة)" },
    "aiRecommendation": { "budget": "string market recommended range in USD", "duration": "string recommended duration range", "milestones": "string recommended milestones count" }
  },
  "triPartyNote": "Concise Arabic sentence explaining how provider's price and duration compare to client constraints and market rates.",
  "finalMetrics": {
    "overallScore": integer 0-100,
    "profileMatch": integer 0-100,
    "messageClarity": integer 0-100,
    "priceCompetitiveness": integer 0-100,
    "timelineFeasibility": integer 0-100,
    "completeness": integer 0-100
  },
  "acceptanceOdds": {
    "statusText": "Status evaluation in Arabic (e.g. عرضك قوي - احتمال القبول مرتفع)",
    "description": "Strategic actionable feedback on how to increase acceptance probability",
    "topPercentage": "Ranking phrase in Arabic (e.g. أفضل من 78% من العروض المشابهة)"
  }
}
`;

    const result = await geminiClient.generateStructured<AiProposalAuditResult>(userPrompt, {
      systemInstruction: systemPrompt,
      responseSchema: AI_PROPOSAL_AUDIT_SCHEMA,
      validate: isValidAiProposalAuditResult,
      temperature: 0.6,
      maxOutputTokens: 1800,
      signal
    });

    return result.data;
  }
}

export const proposalAuditGateway = new ProposalAuditGateway();
export const registerProposalAuditGateway = (socket: Socket) => proposalAuditGateway.register(socket);
