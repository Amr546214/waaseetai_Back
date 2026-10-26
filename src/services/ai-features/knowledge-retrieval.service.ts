import { waseetAiClient, type WaseetAiClient } from '../ai/waseet-ai/waseet-ai.client';
import type { WaseetActor } from '../ai/waseet-ai/waseet-ai.auth';
import type { KnowledgeSearchRequest } from '../ai/waseet-ai/waseet-ai.types';
import { normalizeWaseetAiError } from '../ai/waseet-ai/waseet-ai.errors';

export interface StoredKnowledgeDoc {
  documentId: string;
  version: string;
  title: string;
  locale: string;
  content: string;
  status: 'DRAFT' | 'APPROVED' | 'DEPRECATED';
  audience: 'all' | 'client' | 'provider' | 'admin';
  createdAt: string;
  sourceUrl?: string;
  sourceVersion?: number;
  approvedBy?: string;
  approvedAt?: string;
  ownerId?: string;
  embedding?: number[];
  embeddingModel?: string;
}

export interface RetrievalOptions {
  locale?: string;
  sourceVersion?: number;
  limit?: number;
  audience?: 'all' | 'client' | 'provider' | 'admin' | string;
  queryEmbedding?: number[];
  embeddingModel?: string;
  actor?: WaseetActor;
  signal?: AbortSignal;
}

/**
 * Normalizes text for Arabic + English retrieval:
 * NFKC normalize, strips Arabic tashkeel/tatweel, normalizes alef and yaa, splits into tokens >= 2 chars.
 */
export function normalizedTerms(text: string): string[] {
  if (!text || typeof text !== 'string') return [];
  return (
    text
      .toLowerCase()
      .normalize('NFKC')
      .replace(/[\u064B-\u065F\u0670ـ]/g, '')
      .replace(/[أإآ]/g, 'ا')
      .replace(/ى/g, 'ي')
      .match(/[\p{L}\p{N}]{2,}/gu) ?? []
  );
}

/**
 * Computes cosine similarity between two numeric embedding vectors.
 */
export function cosine(first: number[], second: number[]): number {
  if (
    first.length !== second.length ||
    !first.length ||
    first.some((value) => !Number.isFinite(value)) ||
    second.some((value) => !Number.isFinite(value))
  ) {
    return 0;
  }
  let product = 0;
  let firstSize = 0;
  let secondSize = 0;
  for (let index = 0; index < first.length; index++) {
    const a = first[index]!;
    const b = second[index]!;
    product += a * b;
    firstSize += a * a;
    secondSize += b * b;
  }
  return firstSize && secondSize ? product / Math.sqrt(firstSize * secondSize) : 0;
}

/**
 * Hybrid BM25 + Vector Rank Fusion (RRF).
 * Faithfully matches Waseet AI microservice retrieval logic.
 */
export function rankKnowledge(
  query: string,
  docs: StoredKnowledgeDoc[],
  options: RetrievalOptions = {}
): StoredKnowledgeDoc[] {
  const terms = [...new Set(normalizedTerms(query))];
  if (!terms.length || !docs.length) return [];

  const tokens = docs.map((doc) => normalizedTerms(`${doc.title} ${doc.title} ${doc.content}`));
  const average = tokens.reduce((sum, values) => sum + values.length, 0) / docs.length || 1;

  // 1. Lexical BM25 Scoring
  const lexical = docs
    .map((doc, index) => {
      const values = tokens[index]!;
      const score = terms.reduce((sum, term) => {
        const frequency = values.filter((value) => value === term).length;
        const documentCount = tokens.filter((value) => value.includes(term)).length;
        const idf = Math.log(1 + (docs.length - documentCount + 0.5) / (documentCount + 0.5));
        return sum + (idf * frequency * 2.2) / (frequency + 1.2 * (0.25 + (0.75 * values.length) / average));
      }, 0);
      return { doc, score };
    })
    .filter((item) => item.score > 0)
    .sort((first, second) => second.score - first.score);

  // 2. Semantic Cosine Vector Matching (when embedding vectors are available)
  const semantic =
    options.queryEmbedding && options.embeddingModel
      ? docs
          .map((doc) => ({
            doc,
            score:
              doc.embedding && doc.embeddingModel === options.embeddingModel
                ? cosine(options.queryEmbedding!, doc.embedding)
                : 0,
          }))
          .filter((item) => item.score >= 0.4)
          .sort((first, second) => second.score - first.score)
      : [];

  // 3. Reciprocal Rank Fusion (RRF)
  const fused = new Map<string, { doc: StoredKnowledgeDoc; score: number }>();
  for (const ranked of [lexical, semantic]) {
    ranked.forEach((item, rank) => {
      const entry = fused.get(item.doc.documentId) ?? { doc: item.doc, score: 0 };
      entry.score += 1 / (60 + rank + 1);
      fused.set(item.doc.documentId, entry);
    });
  }

  const limit = Math.min(8, Math.max(1, options.limit ?? 5));
  return [...fused.values()]
    .sort((first, second) => second.score - first.score)
    .slice(0, limit)
    .map((item) => item.doc);
}

/** Standard platform policy documents seeded for hybrid retrieval */
export const PLATFORM_KNOWLEDGE_DOCS: StoredKnowledgeDoc[] = [
  {
    documentId: 'policy-escrow',
    version: '1.0.0',
    title: 'سياسة الضمان المالي وحماية المعاملات (Escrow)',
    locale: 'ar',
    content:
      'عند قبول عرض والدفع، يُحجز مبلغ المشروع في مسار ضمان مالي (Escrow) تشغيلي لحماية الطرفين. المال لا يصل لمقدم الخدمة إلا بعد تسليم مقبول أو انتهاء مهلة الاعتراض دون نزاع. يحدث الإفراج عند اجتماع ثلاثة شروط: تسليم المرحلة المتفق عليها، واعتماد طالب الخدمة يدوياً أو انتهاء مهلة المراجعة، وعدم وجود نزاع أو تجميد مفتوح. القرار النهائي بالاعتماد بيد طالب الخدمة ولا يفرج أي ذكاء اصطناعي عن أموال تلقائياً.',
    status: 'APPROVED',
    audience: 'all',
    createdAt: '2026-01-01T00:00:00.000Z',
    approvedBy: 'compliance-team',
    approvedAt: '2026-01-01T00:00:00.000Z',
  },
  {
    documentId: 'policy-disputes',
    version: '1.0.0',
    title: 'سياسة وإجراءات فتح النزاعات والوساطة',
    locale: 'ar',
    content:
      'يحق للمستخدم فتح نزاع رسمي إذا لم يُسلَّم العمل في الموعد المتفق عليه، أو كان التسليم مخالفاً جوهرياً للعقد، أو وجدت مشكلة جودة واضحة خلال مهلة المراجعة. بمجرد فتح النزاع يُعلق الإفراج عن المبلغ المرتبط بالمرحلة فوراً. يراجع فريق الإدارة البشري تفاصيل النزاع والأدلة والرسائل المتبادلة ويصدر قراراً ملزماً.',
    status: 'APPROVED',
    audience: 'all',
    createdAt: '2026-01-01T00:00:00.000Z',
    approvedBy: 'compliance-team',
    approvedAt: '2026-01-01T00:00:00.000Z',
  },
  {
    documentId: 'policy-ai-role',
    version: '1.0.0',
    title: 'دور وضوابط الذكاء الاصطناعي في منصة وسيط',
    locale: 'ar',
    content:
      'يؤدي الذكاء الاصطناعي دورين استشاريين: توصية (صياغة الطلبات، اقتراح المراحل، تنبيهات السعر والمدة) وتقييم استشاري (جودة التسليم، مؤشرات الأداء، تلخيص النزاعات). الذكاء الاصطناعي مساعد وليس جهة قرار مطلقة، ولا يصدر قرارات ملزمة ولا يفرج عن مبالغ الضمان المالي ولا يوقع عقوداً.',
    status: 'APPROVED',
    audience: 'all',
    createdAt: '2026-01-01T00:00:00.000Z',
    approvedBy: 'ai-governance',
    approvedAt: '2026-01-01T00:00:00.000Z',
  },
  {
    documentId: 'policy-broker-commission',
    version: '1.0.0',
    title: 'سياسة عمولة الوسيط التسويقي وقاعدة First-Touch',
    locale: 'ar',
    content:
      'العمولة التسويقية لا تُحسب بمجرد التسجيل أو الإيداع، بل عند إفراج مرحلة أو استقرار معاملة مالية معتمدة من عميل أُحيل عبر الرابط. تطبق قاعدة First-Touch حيث يبقى أول وسيط يجلب العميل صاحب الإحالة مدى الحياة. الإحالة الذاتية وحسابات الأقارب للتحايل مرفوضة قطعياً وتؤدي لتجميد الأرباح وإلغائها.',
    status: 'APPROVED',
    audience: 'all',
    createdAt: '2026-01-01T00:00:00.000Z',
    approvedBy: 'growth-team',
    approvedAt: '2026-01-01T00:00:00.000Z',
  },
  {
    documentId: 'policy-withdrawals',
    version: '1.0.0',
    title: 'سياسة السحب المالي ومواعيد التحويل والحدود الدنيا',
    locale: 'ar',
    content:
      'تُعالج طلبات السحب أسبوعياً في دفعة يوم الأربعاء عبر PayPal. الحدّان الأدنيان لسحب مقدم الخدمة والوسيط التسويقي يحددهما نظام الرسوم المعتمد حاليًا ويظهران في صفحة السحب؛ لا تذكر رقمًا محددًا. يُعلق السحب في حالات النزاعات المفتوحة أو شبهات الاحتيال أو نقص بيانات الهوية والامتثال.',
    status: 'APPROVED',
    audience: 'all',
    createdAt: '2026-01-01T00:00:00.000Z',
    approvedBy: 'finance-ops',
    approvedAt: '2026-01-01T00:00:00.000Z',
  },
  {
    documentId: 'policy-accreditation',
    version: '1.0.0',
    title: 'سياسة اعتماد التخصصات ونماذج الأعمال والتقييم',
    locale: 'ar',
    content:
      'كل تخصص يختاره مقدم الخدمة يحتاج لاعتماد مستقل عبر رفع نماذج أعمال سابقة مع إثبات الملكية وخوض اختبار تقييم المهارات. يتاح 3 محاولات لإعادة رفع الوثائق خلال 30 يوماً من الرفض. التقييم الأولي آلي، لكن القرار النهائي بالموافقة أو الرفض هو قرار بشري.',
    status: 'APPROVED',
    audience: 'provider',
    createdAt: '2026-01-01T00:00:00.000Z',
    approvedBy: 'vetting-team',
    approvedAt: '2026-01-01T00:00:00.000Z',
  },
  {
    documentId: 'policy-scope-changes',
    version: '1.0.0',
    title: 'سياسة التعديلات المشمولة مقابل طلب تغيير النطاق',
    locale: 'ar',
    content:
      'التعديل المشمول هو طلب تصحيح أو تحسين يقع ضمن نطاق العمل الأصلي وعدد التعديلات المذكورة في العرض. أي متطلب يقع خارج العقد الأصلي يعتبر تغيير نطاق (Scope Change) ويستلزم إنشاء ملحق تعديل وتحديد ميزانية ومدة إضافية وموافقة الطرفين خطياً قبل البدء.',
    status: 'APPROVED',
    audience: 'all',
    createdAt: '2026-01-01T00:00:00.000Z',
    approvedBy: 'compliance-team',
    approvedAt: '2026-01-01T00:00:00.000Z',
  },
];

export class KnowledgeRetrievalService {
  private docs: Map<string, StoredKnowledgeDoc> = new Map();

  constructor(initialDocs: StoredKnowledgeDoc[] = PLATFORM_KNOWLEDGE_DOCS,
    private readonly client: Pick<WaseetAiClient, 'isConfigured' | 'searchKnowledge'> = waseetAiClient) {
    for (const doc of initialDocs) {
      this.docs.set(doc.documentId, doc);
    }
  }

  /** Remote retrieval is available only with verified user identity; guests use public local text. */
  async searchWithSource(query: string, options: RetrievalOptions = {}): Promise<{
    documents: StoredKnowledgeDoc[]; source: 'WASEET_KNOWLEDGE' | 'LOCAL_LEXICAL';
    retrievalMode: 'hybrid' | 'lexical'; fallbackReason?: 'unavailable' | 'not_configured' | 'guest';
  }> {
    const actor = options.actor;
    const requested = options.audience ?? 'all';
    const audience: KnowledgeSearchRequest['audience'] = actor?.role === 'admin' && ['all', 'client', 'provider', 'admin'].includes(requested)
      ? requested as KnowledgeSearchRequest['audience']
      : requested === actor?.role && (requested === 'client' || requested === 'provider') ? requested : 'all';
    // The local fallback is lexical even if an internal caller supplied vectors.
    const safeOptions = { ...options, audience, queryEmbedding: undefined, embeddingModel: undefined };
    if (options.signal?.aborted) throw options.signal.reason ?? new Error('Request aborted');
    if (actor && this.client.isConfigured()) {
      try {
        const result = await this.client.searchKnowledge({ query, audience, limit: options.limit, locale: options.locale },
          { actor, signal: options.signal });
        if (options.signal?.aborted) throw options.signal.reason ?? new Error('Request aborted');
        const documents = result.documents.filter(doc => doc.status === 'APPROVED' && doc.approvedBy && doc.approvedAt &&
          (doc.audience === 'all' || actor.role === 'admin' || doc.audience === audience) &&
          (!doc.ownerId || actor.role === 'admin' || doc.ownerId === actor.userId));
        return { documents, source: 'WASEET_KNOWLEDGE', retrievalMode: result.retrievalMode };
      } catch (error) {
        if (options.signal?.aborted) throw error;
        const status = normalizeWaseetAiError(error).status;
        if (status === 401 || status === 403) throw error;
        return { documents: await this.search(query, safeOptions), source: 'LOCAL_LEXICAL', retrievalMode: 'lexical', fallbackReason: 'unavailable' };
      }
    }
    return { documents: await this.search(query, safeOptions), source: 'LOCAL_LEXICAL', retrievalMode: 'lexical',
      fallbackReason: actor ? 'not_configured' : 'guest' };
  }

  /**
   * Performs hybrid BM25 + Semantic retrieval across approved platform knowledge docs.
   */
  async search(query: string, options: RetrievalOptions = {}): Promise<StoredKnowledgeDoc[]> {
    const role = options.audience ?? 'all';
    const visible = Array.from(this.docs.values()).filter(
      (doc) =>
        doc.status === 'APPROVED' &&
        !!doc.approvedBy &&
        !!doc.approvedAt &&
        (doc.audience === 'all' || role === 'admin' || role === 'system' || doc.audience === role) &&
        (!options.locale || doc.locale === options.locale) &&
        (!options.sourceVersion || (doc.sourceVersion ?? 1) >= options.sourceVersion)
        && (!doc.ownerId || options.actor?.role === 'admin' || doc.ownerId === options.actor?.userId)
    );

    return rankKnowledge(query, visible, options);
  }

  /**
   * Upserts a knowledge document into the local index.
   */
  upsert(doc: StoredKnowledgeDoc): void {
    this.docs.set(doc.documentId, doc);
  }

  /**
   * Retrieves all approved documents matching an audience.
   */
  getAll(audience: string = 'all', actor?: WaseetActor): StoredKnowledgeDoc[] {
    return Array.from(this.docs.values()).filter(
      (doc) => doc.status === 'APPROVED' && !!doc.approvedBy && !!doc.approvedAt &&
        (doc.audience === 'all' || audience === 'admin' || doc.audience === audience) &&
        (!doc.ownerId || actor?.role === 'admin' || doc.ownerId === actor?.userId)
    );
  }

  /**
   * Retrieves a document by its unique ID.
   */
  getById(id: string): StoredKnowledgeDoc | null {
    return this.docs.get(id) ?? null;
  }
}

export const knowledgeRetrievalService = new KnowledgeRetrievalService();
