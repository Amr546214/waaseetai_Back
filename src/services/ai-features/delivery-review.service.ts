import { z } from 'zod';
import { prisma } from '../../config/db';
import { AppError } from '../../utils/app-error';
import { llmClient, type LlmClient } from '../llm/llm.client';
import { llmErrorToAppError } from '../llm/llm.errors';
import { buildPayload, type AllowRule } from '../llm/llm.payload';
import { GROUNDING_RULES_AR, basedOnSchema, countNumbers, inputsUsed } from './ai-feature.shared';

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
  contentRead: false;
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
  reviewedInputs: { deliveryText: boolean; stageRequirements: boolean; attachmentContent: false };
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
  constructor(private readonly llm: Pick<LlmClient, 'generateJson'> = llmClient) {}

  async review(userId: string, key: string, stageId: string): Promise<DeliveryReviewResult> {
    const contract = await prisma.contract.findFirst({
      where: { OR: [{ projectId: key }, { id: key }], AND: [{ OR: [{ providerId: userId }, { clientId: userId }] }] },
      select: {
        project: { select: { title: true, description: true, requirements: true } },
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

  private empty(message: string, used: string[], unavailable: string[]): DeliveryReviewResult {
    return {
      generationSource: null, insufficientData: true, message, contentRead: false, contentNotice: CONTENT_NOT_READ_NOTICE, requirementsScope: 'PROJECT',
      summary: null, met: [], unmetRequirements: [], observations: [], questionsForReviewer: [], alignedPoints: [], potentialGaps: [],
      reviewedInputs: { deliveryText: false, stageRequirements: false, attachmentContent: false }, inputsUsed: used, unavailableFields: unavailable,
    };
  }
}

export const deliveryReviewService = new DeliveryReviewService();
