import { z } from 'zod';
import { prisma } from '../../config/db';
import { AppError } from '../../utils/app-error';
import { llmClient, type LlmClient } from '../llm/llm.client';
import { llmErrorToAppError } from '../llm/llm.errors';
import { buildPayload, type AllowRule } from '../llm/llm.payload';
import { GROUNDING_RULES_AR, basedOnSchema, countNumbers, inputsUsed } from './ai-feature.shared';

// Feature #18 — advisory project health. Built in-house (LlmClient). Read-only: no DB write, never changes any status or releases
// funds. With no stage data it answers "لا توجد بيانات مراحل" directly and never calls the model.

export const NO_STAGE_DATA_MESSAGE = 'لا توجد بيانات مراحل';

export const PROJECT_HEALTH_ALLOW: AllowRule = {
  stages: [{ order: 'number', title: 'string', status: 'string', days: 'number', percentage: 'number' }],
  totalDays: 'number', daysElapsed: 'number', slackDays: 'number', revisionCount: 'number', disputeCount: 'number', lastActivityDays: 'number',
  closureStatus: 'string', stagesApproved: 'number', stagesTotal: 'number',
};
const PATHS = ['stages', 'totalDays', 'daysElapsed', 'slackDays', 'revisionCount', 'disputeCount', 'lastActivityDays'];

export const ProjectHealthSchema = z.object({
  riskLevelKey: z.enum(['LOW', 'MEDIUM', 'HIGH']),
  confidence: z.number().min(0).max(100),
  healthRating: z.string().min(1).max(80),
  bullets: z.array(z.object({ text: z.string().min(1).max(300), basedOn: basedOnSchema })).min(1).max(6),
});
export type ProjectHealthOutput = z.infer<typeof ProjectHealthSchema>;

// A project that already ended (completed / cancelled, also by a settlement) has no delay risk to predict: the same card gets a retrospective summary of what really happened.
export const ClosureReviewSchema = z.object({
  /** the risk level the project actually ended with (a retrospective grade, not a prediction) */
  riskLevelKey: z.enum(['LOW', 'MEDIUM', 'HIGH']),
  confidence: z.number().min(0).max(100),
  healthRating: z.string().min(1).max(80),
  bullets: z.array(z.object({ text: z.string().min(1).max(300), basedOn: basedOnSchema })).min(1).max(5),
});
export type ClosureReviewOutput = z.infer<typeof ClosureReviewSchema>;
export const CLOSURE_REVIEW_SYSTEM = `أنت محلل مشاريع. المشروع المرسل انتهى (closureStatus: COMPLETED مكتمل أو CANCELLED ملغي/أُغلق بتسوية). لخّص بأمانة وبإيجاز ما حدث فعلاً اعتماداً على بيانات JSON المرسلة فقط: كم مرحلة اعتُمدت من الإجمالي (stagesApproved / stagesTotal)، المدة الكلية والمنقضية، عدد طلبات التعديل ومرات النزاع، وحالة الإغلاق.
- healthRating: وصف قصير جداً لحصيلة المشروع (مثل «أُنجز جزئياً قبل الإغلاق» أو «اكتمل بنجاح»).
- riskLevelKey: LOW أو MEDIUM أو HIGH: درجة المخاطرة التي انتهى بها المشروع فعلاً (تقييم لما حدث وليس توقعاً): LOW مكتمل بلا نزاع، HIGH ملغي أو مغلق بتسوية بعد مراحل قليلة أو بنزاع. confidence: ثقتك من 0 إلى 100 بحسب كفاية البيانات.
- لا تتنبأ بأي خطر تأخر ولا بتواريخ مستقبلية، ولا تُلقِ لوماً على أي طرف، ولا تقترح قرارات مالية، ولا تذكر مبالغ غير موجودة في البيانات.
${GROUNDING_RULES_AR}`;

export const PROJECT_HEALTH_SYSTEM = `أنت محلل صحة مشاريع. تقيّم خطر التأخر والنزاع لمشروع قائم اعتماداً على بيانات JSON المرسلة فقط (المراحل وحالاتها وأيامها، الأيام الكلية، الأيام المنقضية، فارق الجدول slackDays، عدد التعديلات، عدد النزاعات، أيام آخر نشاط).
- riskLevelKey: LOW أو MEDIUM أو HIGH. confidence: رقم من 0 إلى 100 يعبّر عن ثقتك بالتقييم بحسب كفاية البيانات. healthRating: وصف قصير.
- lastActivityDays تقريبي (من آخر تحديث مسجّل) فاذكر ذلك إن استشهدت به.
- لا تتوقع تواريخ أو أرقاماً غير موجودة، ولا تقترح قرارات مالية.
${GROUNDING_RULES_AR}`;

const RISK_LABELS: Record<string, string> = { LOW: 'منخفض', MEDIUM: 'متوسط', HIGH: 'مرتفع' };

export interface ProjectHealthResult {
  generationSource: 'LLM' | null;
  insufficientData: boolean;
  message: string | null;
  // fields the existing screens already read
  confidence: number | null;
  riskLevel: string;
  riskLevelKey: 'LOW' | 'MEDIUM' | 'HIGH' | 'UNKNOWN';
  healthRating: string;
  bullets: string[];
  earlyDays: number | null;
  matchPercentage: number | null;
  /** true: the project already ended; the answer is a retrospective summary (no risk / early days) */
  closed?: boolean;
  // traceability
  bulletsDetailed: Array<{ text: string; basedOn: string[] }>;
  inputsUsed: string[];
  unavailableFields: string[];
  notes: { lastActivityIsApproximate: true };
}

const DAY = 86_400_000;

export class ProjectHealthService {
  constructor(private readonly llm: Pick<LlmClient, 'generateJson'> = llmClient, private readonly now: () => number = Date.now) {}

  async analyze(userId: string, key: string): Promise<ProjectHealthResult> {
    const contract = await prisma.contract.findFirst({
      where: { OR: [{ projectId: key }, { id: key }], AND: [{ OR: [{ providerId: userId }, { clientId: userId }] }] },
      select: {
        projectId: true, durationDays: true, signedAt: true, createdAt: true, updatedAt: true, status: true, project: { select: { status: true } },
        stages: { orderBy: { stepOrder: 'asc' }, select: { stepOrder: true, title: true, status: true, days: true, percentage: true, updatedAt: true, deliveries: { select: { status: true, updatedAt: true } } } },
      },
    });
    if (!contract) throw new AppError('المشروع غير موجود أو لا تملك صلاحية الوصول إليه', 404);

    if (!contract.stages.length) return this.noData();

    const disputeCount = await prisma.dispute.count({ where: { projectId: contract.projectId } });
    const now = this.now();
    const start = (contract.signedAt ?? contract.createdAt).getTime();
    const daysElapsed = Math.max(0, Math.floor((now - start) / DAY));
    const totalDays = contract.durationDays;
    const remainingStageDays = contract.stages.filter((s) => s.status !== 'APPROVED').reduce((sum, s) => sum + s.days, 0);
    const slackDays = totalDays - daysElapsed - remainingStageDays; // > 0: ahead of schedule, < 0: behind
    const revisionCount = contract.stages.reduce((sum, s) => sum + s.deliveries.filter((d) => d.status === 'REVISION_REQUESTED').length, 0);
    const latest = Math.max(contract.updatedAt.getTime(), ...contract.stages.map((s) => s.updatedAt.getTime()), ...contract.stages.flatMap((s) => s.deliveries.map((d) => d.updatedAt.getTime())));
    const lastActivityDays = Math.max(0, Math.floor((now - latest) / DAY));

    const closureStatus = this.closureOf(contract.status as string, (contract as any).project?.status as string | undefined);
    const stagesApproved = contract.stages.filter((s) => s.status === 'APPROVED').length;
    const payload = buildPayload({
      ...(closureStatus ? { closureStatus, stagesApproved, stagesTotal: contract.stages.length } : {}),
      stages: contract.stages.map((s) => ({ order: s.stepOrder, title: s.title, status: s.status, days: s.days, percentage: s.percentage })),
      totalDays, daysElapsed, slackDays, revisionCount, disputeCount, lastActivityDays,
    }, PROJECT_HEALTH_ALLOW) as any;
    const used = inputsUsed(payload, closureStatus ? [...PATHS, 'closureStatus', 'stagesApproved', 'stagesTotal'] : PATHS);
    const unavailable = PATHS.filter((p) => !used.includes(p) && !['revisionCount', 'disputeCount'].includes(p));

    if (closureStatus) {
      try {
        const res = await this.llm.generateJson<ClosureReviewOutput>({
          feature: 'project-closure-review', userId, schema: ClosureReviewSchema, system: CLOSURE_REVIEW_SYSTEM, input: payload,
          timeoutMs: 25_000, maxOutputTokens: 800, cache: true,
          grounding: { basedOn: ['bullets[].basedOn'], freeText: ['healthRating', 'bullets[].text'], allowedNumbers: countNumbers(payload) },
        });
        const d = res.data;
        return {
          generationSource: res.source, insufficientData: false, message: null,
          confidence: d.confidence, riskLevel: RISK_LABELS[d.riskLevelKey], riskLevelKey: d.riskLevelKey, healthRating: d.healthRating,
          // early days only mean something for a project that was completed (positive = finished ahead of the plan); a cancelled one has none
          bullets: d.bullets.map((b) => b.text), earlyDays: closureStatus === 'COMPLETED' ? slackDays : null,
          matchPercentage: contract.stages.length > 0 ? Math.round((stagesApproved / contract.stages.length) * 100) : null, closed: true,
          bulletsDetailed: d.bullets, inputsUsed: used, unavailableFields: unavailable, notes: { lastActivityIsApproximate: true },
        };
      } catch (error) {
        throw llmErrorToAppError(error);
      }
    }

    try {
      const res = await this.llm.generateJson<ProjectHealthOutput>({
        feature: 'project-health', userId, schema: ProjectHealthSchema, system: PROJECT_HEALTH_SYSTEM, input: payload,
        timeoutMs: 25_000, maxOutputTokens: 900, cache: true,
        grounding: { basedOn: ['bullets[].basedOn'], freeText: ['healthRating', 'bullets[].text'], allowedNumbers: countNumbers(payload) },
      });
      const d = res.data;
      return {
        generationSource: res.source, insufficientData: false, message: null,
        confidence: d.confidence, riskLevel: RISK_LABELS[d.riskLevelKey], riskLevelKey: d.riskLevelKey, healthRating: d.healthRating,
        bullets: d.bullets.map((b) => b.text), earlyDays: slackDays, matchPercentage: null,
        bulletsDetailed: d.bullets, inputsUsed: used, unavailableFields: unavailable, notes: { lastActivityIsApproximate: true },
      };
    } catch (error) {
      throw llmErrorToAppError(error);
    }
  }

  /** COMPLETED / CANCELLED when the contract or the project ended (a settlement closes the contract as cancelled), else null. */
  private closureOf(contractStatus: string | undefined, projectStatus: string | undefined): 'COMPLETED' | 'CANCELLED' | null {
    const all = [contractStatus, projectStatus].map((v) => String(v ?? '').toUpperCase());
    if (all.includes('CANCELLED')) return 'CANCELLED';
    if (all.includes('COMPLETED')) return 'COMPLETED';
    return null;
  }

  private noData(): ProjectHealthResult {
    return {
      generationSource: null, insufficientData: true, message: NO_STAGE_DATA_MESSAGE,
      confidence: null, riskLevel: 'غير محسوبة', riskLevelKey: 'UNKNOWN', healthRating: NO_STAGE_DATA_MESSAGE,
      bullets: [NO_STAGE_DATA_MESSAGE], earlyDays: null, matchPercentage: null,
      bulletsDetailed: [], inputsUsed: [], unavailableFields: ['stages'], notes: { lastActivityIsApproximate: true },
    };
  }
}

export const projectHealthService = new ProjectHealthService();
