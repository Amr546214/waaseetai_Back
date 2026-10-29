import { createHash } from 'node:crypto';
import { z } from 'zod';
import { prisma } from '../../config/db';
import { logger } from '../../config/logger';
import { AppError } from '../../utils/app-error';
import { llmClient, type LlmClient } from '../llm/llm.client';
import { buildPayload, type AllowRule } from '../llm/llm.payload';
import { GROUNDING_RULES_AR, basedOnSchema, countNumbers, inputsUsed } from './ai-feature.shared';
import { aiFailed, aiNotEnoughData, aiReady, parseStoredAiResult, type AiResult } from './ai-result';
import { getLlmConfig } from '../llm/llm.config';
import { waseetAiClient, type WaseetAiClient } from '../ai/waseet-ai/waseet-ai.client';
import { currentWaseetActor } from '../ai/waseet-ai/waseet-ai.auth';
import { checkMultipleContentPolicy } from '../../utils/content-policy-guard';

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
export interface PortfolioReviewDetails { strengths: { text: string; basedOn: string[] }[]; warnings: { text: string; basedOn: string[] }[]; recommendations: { text: string; basedOn: string[] }[];
  contentRead?: boolean; evidence?: unknown[]; unavailable?: string[]; executionVerified?: false }

export const PORTFOLIO_REVIEW_SYSTEM = `أنت مراجع يقيّم نماذج أعمال مقدّم خدمة في تخصص محدد، اعتماداً على بيانات JSON المرسلة فقط (عناوين النماذج ووصفها والتقنيات المذكورة ونوع الملف وعدد ملفات الإثبات).
المطلوب: ملخص قصير (summary)، ونقاط قوة (strengths)، وملاحظات تحتاج انتباهاً (warnings)، وتوصيات لتحسين النماذج (recommendations).
- هذه مراجعة استشارية للنص المرسل فقط: لا تقرّر قبول التخصص أو رفضه، ولا تمنح شارة ولا مستوى، ولا تذكر درجة أو نسبة أو احتمالاً.
- لم يُرسل محتوى الملفات نفسها، فلا تحكم على جودة التنفيذ البصري أو البرمجي؛ احكم على وضوح الوصف وتنوّع النماذج وتغطيتها للتخصص وذكر التقنيات.
- إن كانت الأوصاف قصيرة أو ناقصة فاذكر ذلك كملاحظة ولا تخمّن ما ينقصها.
- لا تكتب أي رموز برمجية أو عبارات تقنية مثل inspected: false أو ERR_INVALID_IP_ADDRESS في النص العربي الموجه للمستخدم.
${GROUNDING_RULES_AR}`;

const sanitizeReviewText = (text: string): string =>
  text
    .replace(/\(\s*inspected\s*:\s*false\s*\)/gi, '')
    .replace(/\binspected\s*:\s*false\b/gi, '')
    .replace(/\bERR_INVALID_IP_ADDRESS\b/g, '')
    .replace(/\bCONTENT_URL_BLOCKED\b/g, '')
    .replace(/\s{2,}/g, ' ')
    .trim();

export type PortfolioReviewResult = AiResult<PortfolioReviewDetails> & { unavailableReason: 'NOT_CONFIGURED' | 'ERROR' | null; samplesCount: number };

const withMeta = (r: AiResult<PortfolioReviewDetails>, samplesCount: number, unavailableReason: PortfolioReviewResult['unavailableReason'] = null): PortfolioReviewResult => ({ ...r, unavailableReason, samplesCount });

export class SpecialtyPortfolioReviewService {
  private readonly inFlight = new Map<string, Promise<PortfolioReviewResult>>();

  constructor(private readonly llm: Pick<LlmClient, 'generateJson'> = llmClient, private readonly db: typeof prisma = prisma,
    private readonly inspection: { enabled?: () => boolean; client?: Pick<WaseetAiClient, 'reviewPortfolio'> } = {}) {}

  private contentEnabled(): boolean { return (this.inspection.enabled ?? (() => process.env.WASEET_AI_GATEWAY_ENABLED === 'true'))(); }

  private async loadOwned(userId: string, providerSpecialtyId: string) {
    const row = await this.db.providerSpecialty.findFirst({
      where: { id: providerSpecialtyId, providerProfile: { userId } },
      select: { id: true, specialty: { select: { nameAr: true, name: true } }, workSamples: { orderBy: { createdAt: 'asc' }, take: 20, select: { title: true, description: true, technologies: true, mimeType: true, publicSampleUrl: true, updatedAt: true, proofs: { select: { id: true, fileName: true, fileUrl: true, mimeType: true, createdAt: true } } } } },
    });
    if (!row) throw new AppError('التخصص غير موجود أو لا تملك صلاحية الوصول إليه', 404);
    return row;
  }

  private buildPayload(row: Awaited<ReturnType<SpecialtyPortfolioReviewService['loadOwned']>>) {
    const payload = buildPayload({
      specialty: { name: row.specialty?.nameAr || row.specialty?.name || null },
      samples: row.workSamples.map((s) => ({ title: s.title, description: s.description, technologies: s.technologies, fileType: s.mimeType, proofFilesCount: s.proofs.length })),
    }, PORTFOLIO_REVIEW_ALLOW) as any;
    if (this.contentEnabled()) payload.inspectionSources = row.workSamples.map(s => ({ projectUrl: s.publicSampleUrl,
      updatedAt: s.updatedAt, attachments: s.proofs.map(p => ({ url: p.fileUrl, name: p.fileName, mimeType: p.mimeType, createdAt: p.createdAt })) }));
    return payload;
  }

  private static hasEnoughData(payload: any): boolean {
    const samples: any[] = Array.isArray(payload?.samples) ? payload.samples : [];
    return samples.some((s) => (typeof s?.title === 'string' && s.title.trim()) && ((typeof s?.description === 'string' && s.description.trim().length >= MIN_SAMPLE_DESCRIPTION_CHARS) || (Array.isArray(s?.technologies) && s.technologies.length > 0)));
  }

  async evaluate(userId: string, providerSpecialtyId: string): Promise<PortfolioReviewResult> {
    const row = await this.loadOwned(userId, providerSpecialtyId);
    const payload = this.buildPayload(row);
    const samplesCount = row.workSamples.length;

    const sampleTexts = row.workSamples.flatMap((s) => [s.title, s.description ?? '']);
    const policy = checkMultipleContentPolicy(sampleTexts);
    if (policy.blocked) {
      return withMeta(
        aiReady<PortfolioReviewDetails>({
          source: 'GEMINI',
          score: null,
          confidence: null,
          summary: policy.reasonAr || 'عذراً، يحتوي نموذج العمل على محتوى يخالف الأنظمة وسياسات منصة وسيط ولا يمكن اعتماده.',
          recommendation: null,
          details: {
            strengths: [],
            warnings: [{ text: policy.reasonAr || 'نموذج العمل يتضمن نشاطاً محظوراً نظاماً وسيتم رفضه من الإدارة.', basedOn: ['samples'] }],
            recommendations: [{ text: 'يرجى استبدال نموذج العمل بنموذج مهني مشروع يلتزم بالأنظمة والقوانين المعتمدة.', basedOn: ['samples'] }],
          },
        }),
        samplesCount
      );
    }

    if (inputsUsed(payload, PATHS).length < 2 || !SpecialtyPortfolioReviewService.hasEnoughData(payload)) return withMeta(aiNotEnoughData<PortfolioReviewDetails>(), samplesCount);

    const inputHash = this.inputHash(payload);
    const jobKey = `${userId}:${providerSpecialtyId}:${inputHash}`;
    const running = this.inFlight.get(jobKey);
    if (running) return running;
    const job = this.run(providerSpecialtyId, userId, payload, inputHash, samplesCount).finally(() => this.inFlight.delete(jobKey));
    this.inFlight.set(jobKey, job);
    return job;
  }

  private async run(providerSpecialtyId: string, userId: string, payload: any, inputHash: string, samplesCount: number): Promise<PortfolioReviewResult> {
    const latest = await this.findLatestLog(providerSpecialtyId);
    if (latest && (latest.rawRequest as any)?.inputHash === inputHash && (!this.contentEnabled() || Date.now() - latest.createdAt.getTime() < 600_000)) {
      const stored = parseStoredAiResult(latest.rawResponse);
      if (stored?.status === 'READY') return withMeta(stored as AiResult<PortfolioReviewDetails>, samplesCount);
    }
    const started = Date.now();
    try {
      const res = this.contentEnabled() ? await this.inspectPortfolio(providerSpecialtyId, userId, payload) : await this.llm.generateJson<PortfolioReviewOutput>({
        feature: 'specialty-portfolio-review', userId, schema: PortfolioReviewSchema, system: PORTFOLIO_REVIEW_SYSTEM, input: payload,
        timeoutMs: 30_000, maxOutputTokens: 1300, cache: false,
        grounding: { basedOn: ['strengths[].basedOn', 'warnings[].basedOn', 'recommendations[].basedOn'], freeText: ['summary', 'strengths[].text', 'warnings[].text', 'recommendations[].text'], allowedNumbers: countNumbers(payload) },
      });
      const result = aiReady<PortfolioReviewDetails>({
        source: this.contentEnabled() ? 'WASEET_AI' : 'GEMINI', score: null, confidence: null, summary: sanitizeReviewText(res.data.summary), recommendation: null,
        details: {
          strengths: res.data.strengths.map((s) => ({ ...s, text: sanitizeReviewText(s.text) })).filter((s) => s.text.length > 0),
          warnings: res.data.warnings.map((w) => ({ ...w, text: sanitizeReviewText(w.text) })).filter((w) => w.text.length > 0),
          recommendations: res.data.recommendations.map((r) => ({ ...r, text: sanitizeReviewText(r.text) })).filter((r) => r.text.length > 0),
          ...('inspectionDetails' in res ? res.inspectionDetails as object : {}),
        },
      });
      try {
        await this.db.aiAuditLog.create({ data: {
          providerSpecialtyId, modelVersion: PORTFOLIO_REVIEW_MODEL_VERSION, promptTokens: res.usage.tokensIn, completionTokens: res.usage.tokensOut,
          totalTokens: res.usage.tokensIn + res.usage.tokensOut, latencyMs: Date.now() - started,
          rawRequest: { inputHash, payload, usageMeasured: res.usage.measured !== false, actualModel: res.model || null } as any, rawResponse: result as any, evaluationResult: 'READY',
        } });
      } catch (storeError) {
        logger.warn(`[SpecialtyPortfolioReview] could not store the result (${(storeError as { code?: string })?.code ?? 'ERROR'})`);
      }
      return withMeta(result, samplesCount);
    } catch (error) {
      const code = (error as { code?: string })?.code ?? 'ERROR';
      logger.warn(`[SpecialtyPortfolioReview] unavailable (${code})`);
      return withMeta({ ...aiFailed<PortfolioReviewDetails>('GEMINI'), details: null }, samplesCount, code === 'NOT_CONFIGURED' ? 'NOT_CONFIGURED' : 'ERROR');
    }
  }

  private async inspectPortfolio(providerSpecialtyId: string, userId: string, payload: any) {
    const schema = z.object({ status: z.literal('PENDING_REVIEW'), inspected: z.boolean(),
      feedback: z.object({ summary: z.string().min(1).max(4000), strengths: z.array(z.string().max(2000)).max(20), warnings: z.array(z.string().max(2000)).max(20), corrections: z.array(z.string().max(2000)).max(20) }),
      evidence: z.array(z.object({ source: z.string().max(2000), sha256: z.string().regex(/^[a-f0-9]{64}$/), contentRead: z.boolean(), excerpt: z.string().max(24000), truncated: z.boolean(), basis: z.string().max(100) })).max(30),
      unavailable: z.array(z.string().max(2500)).max(30) });
    const raw = await (this.inspection.client ?? waseetAiClient).reviewPortfolio({ providerSpecialtyId, specialtyName: payload.specialty.name,
      samples: payload.samples.map((sample: object, i: number) => ({ ...sample, ...payload.inspectionSources[i] })) },
      { actor: currentWaseetActor() ?? { userId, role: 'provider' }, timeoutMs: 60_000 });
    const data = schema.parse(raw);
    if (data.inspected !== data.evidence.some(e => e.contentRead)) throw new Error('INVALID_INSPECTION_BASIS');
    const items = (values: string[]) => values.map(text => ({ text: sanitizeReviewText(text), basedOn: ['samples'] })).filter(i => i.text.length > 0);
    return { data: { summary: sanitizeReviewText(data.feedback.summary), strengths: items(data.feedback.strengths), warnings: items(data.feedback.warnings), recommendations: items(data.feedback.corrections) },
      usage: { tokensIn: 0, tokensOut: 0, measured: false }, model: undefined,
      inspectionDetails: { contentRead: data.inspected, evidence: data.evidence, unavailable: data.unavailable, executionVerified: false } };
  }

  private findLatestLog(providerSpecialtyId: string) {
    return this.db.aiAuditLog.findFirst({ where: { providerSpecialtyId, modelVersion: PORTFOLIO_REVIEW_MODEL_VERSION, evaluationResult: 'READY' }, orderBy: { createdAt: 'desc' }, select: { rawRequest: true, rawResponse: true, createdAt: true } });
  }

  private inputHash(payload: unknown): string {
    const config = getLlmConfig();
    return createHash('sha256').update(JSON.stringify([payload, PORTFOLIO_REVIEW_MODEL_VERSION, PORTFOLIO_REVIEW_SYSTEM,
      config?.provider ?? null, config?.model ?? null, config?.policyVersion ?? null])).digest('hex');
  }

  async latest(userId: string, providerSpecialtyId: string): Promise<PortfolioReviewResult> {
    const row = await this.loadOwned(userId, providerSpecialtyId);
    const log = await this.findLatestLog(providerSpecialtyId);
    if (log && ((log.rawRequest as { inputHash?: string } | null)?.inputHash !== this.inputHash(this.buildPayload(row)) || this.contentEnabled() && Date.now() - log.createdAt.getTime() >= 600_000))
      return withMeta(aiNotEnoughData<PortfolioReviewDetails>(), row.workSamples.length);
    const stored = log ? parseStoredAiResult(log.rawResponse) : null;
    if (!stored || stored.status !== 'READY') return withMeta(aiNotEnoughData<PortfolioReviewDetails>(), row.workSamples.length);
    return withMeta({ ...(stored as AiResult<PortfolioReviewDetails>), generatedAt: stored.generatedAt ?? log!.createdAt.toISOString() }, row.workSamples.length);
  }

  async history(userId: string, providerSpecialtyId: string): Promise<AiResult<PortfolioReviewDetails>[]> {
    await this.loadOwned(userId, providerSpecialtyId);
    const logs = await this.db.aiAuditLog.findMany({ where: { providerSpecialtyId, modelVersion: PORTFOLIO_REVIEW_MODEL_VERSION, evaluationResult: 'READY' }, orderBy: { createdAt: 'desc' }, take: 20, select: { rawResponse: true, createdAt: true } });
    return logs.map((l) => parseStoredAiResult(l.rawResponse)).filter((r): r is AiResult => !!r && r.status === 'READY') as AiResult<PortfolioReviewDetails>[];
  }
}

export const specialtyPortfolioReviewService = new SpecialtyPortfolioReviewService();
