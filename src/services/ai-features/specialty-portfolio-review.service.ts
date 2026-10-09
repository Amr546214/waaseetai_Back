import { createHash } from 'node:crypto';
import { z } from 'zod';
import { prisma } from '../../config/db';
import { logger } from '../../config/logger';
import { AppError } from '../../utils/app-error';
import { llmClient, type LlmClient } from '../llm/llm.client';
import { buildPayload, type AllowRule } from '../llm/llm.payload';
import { GROUNDING_RULES_AR, basedOnSchema, countNumbers, inputsUsed } from './ai-feature.shared';
import { aiFailed, aiNotEnoughData, aiReady, parseStoredAiResult, type AiResult } from './ai-result';

// Advisory AI review of a provider's portfolio / work samples for ONE of their specialties (in-house LlmClient, text metadata only).
//  - It reads the specialty's WorkSample rows (title, description, technologies, file type, number of proof files) and the specialty name.
//    No file content, no links, no proof file names, no user data (name, email, phone, ID, payment) is ever in the payload (allowlist).
//  - Too little to judge -> NOT_ENOUGH_DATA (the model is not called). Model missing / failing / ungrounded -> FAILED (HTTP 200). Never a made-up result.
//  - It is ADVISORY: it never changes the specialty's status, tier or badge; the only write is an AiAuditLog row holding a READY result.
//  - score / confidence stay null: the model is not asked for a number, so none is invented.
//  - Storage: ai_audit_logs (existing table, no migration). A READY result is stored with modelVersion = PORTFOLIO_REVIEW_MODEL_VERSION and the hash of the
//    payload; asking again with the same samples returns the stored result without calling the model. In-flight evaluations of the same specialty are shared.

export const PORTFOLIO_REVIEW_MODEL_VERSION = 'portfolio-review-v1';
export const MIN_SAMPLE_DESCRIPTION_CHARS = 20;

export const PORTFOLIO_REVIEW_ALLOW: AllowRule = {
  specialty: { name: 'string' },
  samples: [{ title: 'string', description: 'text', technologies: ['string'], fileType: 'string', proofFilesCount: 'number' }],
};
const PATHS = ['specialty.name', 'samples[].title', 'samples[].description', 'samples[].technologies'];

const itemSchema = z.object({ text: z.string().min(1).max(300), basedOn: basedOnSchema });
export const PortfolioReviewSchema = z.object({
  summary: z.string().min(1).max(600),
  strengths: z.array(itemSchema).max(5),
  warnings: z.array(itemSchema).max(5),
  recommendations: z.array(itemSchema).max(4),
});
export type PortfolioReviewOutput = z.infer<typeof PortfolioReviewSchema>;
export interface PortfolioReviewDetails { strengths: { text: string; basedOn: string[] }[]; warnings: { text: string; basedOn: string[] }[]; recommendations: { text: string; basedOn: string[] }[] }

export const PORTFOLIO_REVIEW_SYSTEM = `أنت مراجع يقيّم نماذج أعمال مقدّم خدمة في تخصص محدد، اعتماداً على بيانات JSON المرسلة فقط (عناوين النماذج ووصفها والتقنيات المذكورة ونوع الملف وعدد ملفات الإثبات).
المطلوب: ملخص قصير (summary)، ونقاط قوة (strengths)، وملاحظات تحتاج انتباهاً (warnings)، وتوصيات لتحسين النماذج (recommendations).
- هذه مراجعة استشارية للنص المرسل فقط: لا تقرّر قبول التخصص أو رفضه، ولا تمنح شارة ولا مستوى، ولا تذكر درجة أو نسبة أو احتمالاً.
- لم يُرسل محتوى الملفات نفسها، فلا تحكم على جودة التنفيذ البصري أو البرمجي؛ احكم على وضوح الوصف وتنوّع النماذج وتغطيتها للتخصص وذكر التقنيات.
- إن كانت الأوصاف قصيرة أو ناقصة فاذكر ذلك كملاحظة ولا تخمّن ما ينقصها.
${GROUNDING_RULES_AR}`;

export type PortfolioReviewResult = AiResult<PortfolioReviewDetails> & { unavailableReason: 'NOT_CONFIGURED' | 'ERROR' | null; samplesCount: number };

const withMeta = (r: AiResult<PortfolioReviewDetails>, samplesCount: number, unavailableReason: PortfolioReviewResult['unavailableReason'] = null): PortfolioReviewResult => ({ ...r, unavailableReason, samplesCount });

export class SpecialtyPortfolioReviewService {
  private readonly inFlight = new Map<string, Promise<PortfolioReviewResult>>();

  constructor(private readonly llm: Pick<LlmClient, 'generateJson'> = llmClient, private readonly db: typeof prisma = prisma) {}

  /** The specialty (with its samples) of THIS provider, or 404: another provider's specialty is indistinguishable from a missing one. */
  private async loadOwned(userId: string, providerSpecialtyId: string) {
    const row = await this.db.providerSpecialty.findFirst({
      where: { id: providerSpecialtyId, providerProfile: { userId } },
      select: { id: true, specialty: { select: { nameAr: true, name: true } }, workSamples: { orderBy: { createdAt: 'asc' }, take: 20, select: { title: true, description: true, technologies: true, mimeType: true, proofs: { select: { id: true } } } } },
    });
    if (!row) throw new AppError('التخصص غير موجود أو لا تملك صلاحية الوصول إليه', 404);
    return row;
  }

  private buildPayload(row: Awaited<ReturnType<SpecialtyPortfolioReviewService['loadOwned']>>) {
    return buildPayload({
      specialty: { name: row.specialty?.nameAr || row.specialty?.name || null },
      samples: row.workSamples.map((s) => ({ title: s.title, description: s.description, technologies: s.technologies, fileType: s.mimeType, proofFilesCount: s.proofs.length })),
    }, PORTFOLIO_REVIEW_ALLOW) as any;
  }

  private static hasEnoughData(payload: any): boolean {
    const samples: any[] = Array.isArray(payload?.samples) ? payload.samples : [];
    return samples.some((s) => (typeof s?.title === 'string' && s.title.trim()) && ((typeof s?.description === 'string' && s.description.trim().length >= MIN_SAMPLE_DESCRIPTION_CHARS) || (Array.isArray(s?.technologies) && s.technologies.length > 0)));
  }

  async evaluate(userId: string, providerSpecialtyId: string): Promise<PortfolioReviewResult> {
    const row = await this.loadOwned(userId, providerSpecialtyId);
    const payload = this.buildPayload(row);
    const samplesCount = row.workSamples.length;
    if (inputsUsed(payload, PATHS).length < 2 || !SpecialtyPortfolioReviewService.hasEnoughData(payload)) return withMeta(aiNotEnoughData<PortfolioReviewDetails>(), samplesCount);

    const inputHash = createHash('sha256').update(JSON.stringify(payload)).digest('hex');
    const running = this.inFlight.get(providerSpecialtyId);
    if (running) return running; // concurrent request for the same specialty: share the one evaluation
    const job = this.run(providerSpecialtyId, userId, payload, inputHash, samplesCount).finally(() => this.inFlight.delete(providerSpecialtyId));
    this.inFlight.set(providerSpecialtyId, job);
    return job;
  }

  private async run(providerSpecialtyId: string, userId: string, payload: any, inputHash: string, samplesCount: number): Promise<PortfolioReviewResult> {
    // same samples as the stored READY result: nothing new to evaluate
    const latest = await this.findLatestLog(providerSpecialtyId);
    if (latest && (latest.rawRequest as any)?.inputHash === inputHash) {
      const stored = parseStoredAiResult(latest.rawResponse);
      if (stored?.status === 'READY') return withMeta(stored as AiResult<PortfolioReviewDetails>, samplesCount);
    }
    const started = Date.now();
    try {
      const res = await this.llm.generateJson<PortfolioReviewOutput>({
        feature: 'specialty-portfolio-review', userId, schema: PortfolioReviewSchema, system: PORTFOLIO_REVIEW_SYSTEM, input: payload,
        timeoutMs: 30_000, maxOutputTokens: 1300, cache: false,
        grounding: { basedOn: ['strengths[].basedOn', 'warnings[].basedOn', 'recommendations[].basedOn'], freeText: ['summary', 'strengths[].text', 'warnings[].text', 'recommendations[].text'], allowedNumbers: countNumbers(payload) },
      });
      const result = aiReady<PortfolioReviewDetails>({
        source: 'GEMINI', score: null, confidence: null, summary: res.data.summary, recommendation: null,
        details: { strengths: res.data.strengths, warnings: res.data.warnings, recommendations: res.data.recommendations },
      });
      try {
        await this.db.aiAuditLog.create({ data: {
          providerSpecialtyId, modelVersion: PORTFOLIO_REVIEW_MODEL_VERSION, promptTokens: res.usage.tokensIn, completionTokens: res.usage.tokensOut,
          totalTokens: res.usage.tokensIn + res.usage.tokensOut, latencyMs: Date.now() - started,
          rawRequest: { inputHash, payload } as any, rawResponse: result as any, evaluationResult: 'READY',
        } });
      } catch (storeError) {
        // the review itself succeeded; failing to keep it only means it is not remembered after a refresh
        logger.warn(`[SpecialtyPortfolioReview] could not store the result (${(storeError as { code?: string })?.code ?? 'ERROR'})`);
      }
      return withMeta(result, samplesCount);
    } catch (error) {
      const code = (error as { code?: string })?.code ?? 'ERROR';
      logger.warn(`[SpecialtyPortfolioReview] unavailable (${code})`);
      return withMeta({ ...aiFailed<PortfolioReviewDetails>('GEMINI'), details: null }, samplesCount, code === 'NOT_CONFIGURED' ? 'NOT_CONFIGURED' : 'ERROR');
    }
  }

  private findLatestLog(providerSpecialtyId: string) {
    return this.db.aiAuditLog.findFirst({ where: { providerSpecialtyId, modelVersion: PORTFOLIO_REVIEW_MODEL_VERSION, evaluationResult: 'READY' }, orderBy: { createdAt: 'desc' }, select: { rawRequest: true, rawResponse: true, createdAt: true } });
  }

  /** The latest stored READY evaluation, or NOT_ENOUGH_DATA with nothing in it when there is none. */
  async latest(userId: string, providerSpecialtyId: string): Promise<PortfolioReviewResult> {
    const row = await this.loadOwned(userId, providerSpecialtyId);
    const log = await this.findLatestLog(providerSpecialtyId);
    const stored = log ? parseStoredAiResult(log.rawResponse) : null;
    if (!stored || stored.status !== 'READY') return withMeta(aiNotEnoughData<PortfolioReviewDetails>(), row.workSamples.length);
    return withMeta({ ...(stored as AiResult<PortfolioReviewDetails>), generatedAt: stored.generatedAt ?? log!.createdAt.toISOString() }, row.workSamples.length);
  }

  /** Stored READY evaluations, newest first. */
  async history(userId: string, providerSpecialtyId: string): Promise<AiResult<PortfolioReviewDetails>[]> {
    await this.loadOwned(userId, providerSpecialtyId);
    const logs = await this.db.aiAuditLog.findMany({ where: { providerSpecialtyId, modelVersion: PORTFOLIO_REVIEW_MODEL_VERSION, evaluationResult: 'READY' }, orderBy: { createdAt: 'desc' }, take: 20, select: { rawResponse: true, createdAt: true } });
    return logs.map((l) => parseStoredAiResult(l.rawResponse)).filter((r): r is AiResult => !!r && r.status === 'READY') as AiResult<PortfolioReviewDetails>[];
  }
}

export const specialtyPortfolioReviewService = new SpecialtyPortfolioReviewService();
