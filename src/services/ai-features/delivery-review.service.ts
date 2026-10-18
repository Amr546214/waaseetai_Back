import { z } from 'zod';
import { prisma } from '../../config/db';
import { AppError } from '../../utils/app-error';
import { llmClient, type LlmClient } from '../llm/llm.client';
import { llmErrorToAppError } from '../llm/llm.errors';
import { buildPayload, type AllowRule } from '../llm/llm.payload';
import { GROUNDING_RULES_AR, basedOnSchema, countNumbers, inputsUsed } from './ai-feature.shared';
import { waseetAiClient, type WaseetAiClient } from '../ai/waseet-ai/waseet-ai.client';
import { currentWaseetActor } from '../ai/waseet-ai/waseet-ai.auth';

// Features #19/#24 — advisory review of a stage delivery. Built in-house (LlmClient). It NEVER approves/rejects a delivery and never
// reads file CONTENT: only the note and each file's name + extension (derived from its URL). Requirements are the PROJECT's
// requirements[] (ProjectStage stores no per-stage requirements) and the payload says so. No cache: a delivery can change.

export const CONTENT_NOT_READ_NOTICE = 'لا يقرأ هذا التحليل محتوى الملفات المرفقة، بل أسماءها وامتداداتها فقط.';
export const NO_DELIVERY_MESSAGE = 'لا يوجد تسليم لهذه المرحلة';
export const NOT_ENOUGH_DELIVERY_DATA_MESSAGE = 'لا توجد ملاحظة تسليم أو ملفات كافية للمراجعة';

export const DELIVERY_REVIEW_ALLOW: AllowRule = {
  stage: { title: 'string', description: 'text' },
  delivery: { note: 'text', files: [{ name: 'string', ext: 'string' }], submittedAt: 'date', revisionNumber: 'number' },
  project: { title: 'string', description: 'text', requirements: ['text'] },
  requirementsScope: 'string',
  contentRead: 'boolean',
};
const PATHS = ['stage.title', 'stage.description', 'delivery.note', 'delivery.files', 'delivery.submittedAt', 'delivery.revisionNumber', 'project.title', 'project.description', 'project.requirements'];

export const DeliveryReviewSchema = z.object({
  summary: z.string().min(1).max(600),
  /** requirements the delivery note / file names visibly address; `requirement` must be one of project.requirements[], `evidence` a literal quote from the note or a file name */
  met: z.array(z.object({ requirement: z.string().min(1).max(500), evidence: z.string().min(1).max(500) })).max(20),
  observations: z.array(z.object({ text: z.string().min(1).max(300), basedOn: basedOnSchema })).max(6),
  questionsForReviewer: z.array(z.string().min(1).max(300)).max(5),
});
export type DeliveryReviewOutput = z.infer<typeof DeliveryReviewSchema>;

export const DELIVERY_REVIEW_SYSTEM = `أنت مساعد استشاري لمراجع تسليم مرحلة في مشروع. لا تقرّر قبولاً أو رفضاً، وإنما تقارن ما أُرسل فقط.
المدخلات: stage وdelivery (ملاحظة التسليم وأسماء الملفات وامتداداتها فقط) وproject (وصفه ومتطلباته requirements — وهي متطلبات المشروع كله وليست متطلبات المرحلة).
- أنت لا تقرأ محتوى الملفات إطلاقاً: لا تصف ما بداخلها ولا تدّعِ فحصها.
- met: المتطلبات التي تشير إليها ملاحظة التسليم أو أسماء الملفات بوضوح. requirement نسخة حرفية تماماً من عنصر في project.requirements، و evidence اقتباس حرفي من ملاحظة التسليم أو من اسم ملف. لا تضع متطلباً دون دليل حرفي.
- لا تُدرج في met أي متطلب لا يظهر دليل عليه؛ ستعدّد الواجهة غير المستوفى تلقائياً.
- observations: ملاحظات قصيرة مبنية على الحقول المرسلة. questionsForReviewer: أسئلة يطرحها المراجع على المقدّم.
${GROUNDING_RULES_AR}`;

export interface DeliveryReviewResult {
  generationSource: 'LLM' | null;
  insufficientData: boolean;
  message: string | null;
  /** Fixed: the review never reads file contents. */
  contentRead: boolean;
  contentNotice: string;
  requirementsScope: 'PROJECT';
  summary: string | null;
  met: Array<{ requirement: string; evidence: string }>;
  unmetRequirements: string[];
  observations: Array<{ text: string; basedOn: string[] }>;
  questionsForReviewer: string[];
  // fields the existing screens already read
  alignedPoints: string[];
  potentialGaps: string[];
  reviewedInputs: { deliveryText: boolean; stageRequirements: boolean; attachmentContent: boolean };
  evidence?: Array<{ source: string; sha256: string; contentRead: boolean; excerpt: string; truncated: boolean; basis: string }>;
  execution?: { status: 'UNAVAILABLE'; executed: false; reason: string };
  inputsUsed: string[];
  unavailableFields: string[];
}

const nameFromUrl = (url: string): string => {
  try { return decodeURIComponent(new URL(url).pathname.split('/').pop() || ''); } catch { return url.split('?')[0].split('/').pop() || ''; }
};
/** StageDelivery.files holds URLs or JSON-stringified {name,url}. Only a name and an extension are ever derived — never the URL itself. */
export function fileNameAndExt(entry: string): { name: string; ext: string } {
  let name = '';
  const t = (entry ?? '').trim();
  if (t.startsWith('{')) {
    try { const o = JSON.parse(t); name = String(o.name || o.fileName || nameFromUrl(String(o.url || o.fileUrl || ''))); } catch { name = ''; }
  } else name = nameFromUrl(t);
  const dot = name.lastIndexOf('.');
  return { name, ext: dot > 0 && dot < name.length - 1 ? name.slice(dot + 1).toLowerCase() : '' };
}

export class DeliveryReviewService {
  constructor(private readonly llm: Pick<LlmClient, 'generateJson'> = llmClient,
    private readonly inspection: { enabled?: () => boolean; client?: Pick<WaseetAiClient, 'reviewDelivery'> } = {}) {}

  async review(userId: string, key: string, stageId: string): Promise<DeliveryReviewResult> {
    const contract = await prisma.contract.findFirst({
      where: { OR: [{ projectId: key }, { id: key }], AND: [{ OR: [{ providerId: userId }, { clientId: userId }] }] },
      select: {
        project: { select: { id: true, title: true, description: true, requirements: true } },
        stages: { where: { id: stageId }, select: { title: true, description: true, deliveries: { orderBy: { submittedAt: 'asc' }, select: { note: true, files: true, submittedAt: true } } } },
      },
    });
    const stage = contract?.stages[0];
    if (!contract || !stage) throw new AppError('المرحلة غير موجودة أو لا تملك صلاحية الوصول إليها', 404);
    if (!stage.deliveries.length) return this.empty(NO_DELIVERY_MESSAGE, [], PATHS);

    const revisionNumber = stage.deliveries.length; // the latest delivery's position in submission order
    const latest = stage.deliveries[revisionNumber - 1];
    const payload = buildPayload({
      stage: { title: stage.title, description: stage.description },
      delivery: { note: latest.note, files: (latest.files ?? []).map(fileNameAndExt), submittedAt: latest.submittedAt, revisionNumber },
      project: { title: contract.project.title, description: contract.project.description, requirements: contract.project.requirements },
      requirementsScope: 'PROJECT',
      contentRead: false,
    }, DELIVERY_REVIEW_ALLOW) as any;

    const used = inputsUsed(payload, PATHS);
    const unavailable = PATHS.filter((p) => !used.includes(p));
    const requirements: string[] = (payload.project.requirements as string[]).filter((r) => typeof r === 'string' && r.trim());
    // nothing the model could actually compare → say so
    if (!used.includes('delivery.note') && !used.includes('delivery.files')) return this.empty(NOT_ENOUGH_DELIVERY_DATA_MESSAGE, used, unavailable);

    if ((this.inspection.enabled ?? (() => process.env.WASEET_AI_GATEWAY_ENABLED === 'true'))()) {
      return this.reviewContent(userId, contract.project.id || key, stageId, payload, latest.files ?? [], used, unavailable, requirements);
    }

    try {
      const res = await this.llm.generateJson<DeliveryReviewOutput>({
        feature: 'delivery-review', userId, schema: DeliveryReviewSchema, system: DELIVERY_REVIEW_SYSTEM, input: payload,
        timeoutMs: 30_000, maxOutputTokens: 1500, cache: false,
        grounding: {
          ids: [{ output: 'met[].requirement', input: 'project.requirements[]' }],
          quotes: ['met[].evidence'],
          basedOn: ['observations[].basedOn'],
          freeText: ['summary', 'observations[].text', 'questionsForReviewer[]'],
          allowedNumbers: countNumbers(payload),
        },
      });
      const d = res.data;
      const metSet = new Set(d.met.map((m) => m.requirement));
      const unmet = requirements.filter((r) => !metSet.has(r));
      return {
        generationSource: res.source, insufficientData: false, message: null, contentRead: false, contentNotice: CONTENT_NOT_READ_NOTICE, requirementsScope: 'PROJECT',
        summary: d.summary, met: d.met, unmetRequirements: unmet, observations: d.observations, questionsForReviewer: d.questionsForReviewer,
        alignedPoints: d.met.map((m) => `${m.requirement} — «${m.evidence}»`), potentialGaps: [...unmet.map((r) => `غير موثّق في التسليم: ${r}`), ...d.observations.map((o) => o.text)],
        reviewedInputs: { deliveryText: used.includes('delivery.note'), stageRequirements: requirements.length > 0, attachmentContent: false },
        inputsUsed: used, unavailableFields: unavailable,
      };
    } catch (error) {
      throw llmErrorToAppError(error);
    }
  }

  private async reviewContent(userId: string, projectId: string, stageId: string, payload: any, entries: string[], used: string[], unavailable: string[], requirements: string[]): Promise<DeliveryReviewResult> {
    const files = entries.slice(0, 6).flatMap(entry => {
      let url = entry, name = fileNameAndExt(entry).name;
      if (entry.trim().startsWith('{')) {
        try { const object = JSON.parse(entry); url = object.url || object.fileUrl; } catch { return []; }
      }
      try { const parsed = new URL(url); if (parsed.protocol !== 'https:' || parsed.username || parsed.password) return []; }
      catch { return []; }
      return [{ name: name.slice(0, 300) || 'attachment', url }];
    });
    const schema = z.object({ summary: z.string().min(1).max(4000), contentRead: z.boolean(),
      requirementsScope: z.literal('PROJECT'), met: z.array(z.object({ requirement: z.string().max(2000), evidence: z.string().min(1).max(2000), source: z.string().min(1).max(2000) })).max(50),
      potentialGaps: z.array(z.string().max(2000)).max(60), questionsForReviewer: z.array(z.string().max(2000)).max(20),
      evidence: z.array(z.object({ source: z.string().max(2000), sha256: z.string().regex(/^[a-f0-9]{64}$/), contentRead: z.boolean(), excerpt: z.string().max(24000), truncated: z.boolean(), basis: z.string().max(100) })).max(30),
      unavailable: z.array(z.string().max(2500)).max(30),
      execution: z.object({ status: z.literal('UNAVAILABLE'), executed: z.literal(false), reason: z.string().max(1000) }),
    });
    try {
      const actor = currentWaseetActor();
      const raw = await (this.inspection.client ?? waseetAiClient).reviewDelivery({ view: actor?.role === 'provider' ? 'provider' : 'client',
        projectId, stageId, scopeAgreed: payload.stage.description || '', submissionDetails: payload.delivery.note || '',
        requirements, requirementsScope: 'PROJECT', files, deliverableLinks: [] },
        { actor: actor ?? { userId, role: 'client' }, timeoutMs: 60_000 });
      const data = schema.parse(raw);
      const evidenceBySource = new Map(data.evidence.filter(e => e.contentRead).map(e => [e.source, e.excerpt]));
      if (data.contentRead !== (evidenceBySource.size > 0) || data.met.some(m => !requirements.includes(m.requirement)
        || !(m.source === 'delivery-note' ? String(payload.delivery.note || '') : evidenceBySource.get(m.source) || '').includes(m.evidence)))
        throw new Error('UNGROUNDED_DELIVERY_EVIDENCE');
      const met = data.met.map(m => ({ requirement: m.requirement, evidence: m.evidence }));
      const documented = new Set(met.map(m => m.requirement));
      const unmetRequirements = requirements.filter(r => !documented.has(r));
      return { generationSource: 'LLM', insufficientData: false, message: null, contentRead: data.contentRead,
        contentNotice: data.contentRead ? 'قُرئت الأجزاء النصية المحددة في الأدلة؛ لم يُشغّل الكود ولم يُعتمد التسليم تلقائياً.' : CONTENT_NOT_READ_NOTICE,
        requirementsScope: 'PROJECT', summary: data.summary, met, unmetRequirements, observations: [], questionsForReviewer: data.questionsForReviewer,
        alignedPoints: met.map(m => `${m.requirement} — «${m.evidence}»`), potentialGaps: data.potentialGaps,
        reviewedInputs: { deliveryText: used.includes('delivery.note'), stageRequirements: requirements.length > 0, attachmentContent: data.contentRead },
        evidence: data.evidence, execution: data.execution, inputsUsed: [...used, ...(data.contentRead ? ['delivery.attachmentContent'] : [])],
        unavailableFields: [...unavailable, ...data.unavailable] };
    } catch {
      throw new AppError('تعذر فحص محتوى التسليم أو التحقق من أدلته حالياً. لم يُعتمد التسليم تلقائياً.', 503);
    }
  }

  private empty(message: string, used: string[], unavailable: string[]): DeliveryReviewResult {
    return {
      generationSource: null, insufficientData: true, message, contentRead: false, contentNotice: CONTENT_NOT_READ_NOTICE, requirementsScope: 'PROJECT',
      summary: null, met: [], unmetRequirements: [], observations: [], questionsForReviewer: [], alignedPoints: [], potentialGaps: [],
      reviewedInputs: { deliveryText: false, stageRequirements: false, attachmentContent: false }, inputsUsed: used, unavailableFields: unavailable,
    };
  }
}

export const deliveryReviewService = new DeliveryReviewService();
