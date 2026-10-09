import { prisma } from '../../config/db';
import { scrubFreeText } from '../llm/llm.payload';
import type { AllowRule } from '../llm/llm.payload';
import { metricSummaryEngine, type MetricSummaryEngine, type MetricSummaryResult } from './metric-summary';
import {
  ANOMALY_WINDOW_DAYS, FORECAST_MIN_MONTHS, FORECAST_WINDOW_MONTHS, SENTIMENT_MAX_SNIPPETS, SENTIMENT_MIN_REVIEWS, SENTIMENT_SNIPPET_CHARS,
  buildForecastMetrics, buildSentimentMetrics, dailyAnomalyStats, lastCompleteMonths, lastDays, topCounts,
  type DailyStats, type ForecastMetrics, type SentimentMetrics,
} from './admin-ai-summaries.stats';

// Three READ-ONLY admin AI summaries over REAL tables. Every number is computed here (deterministic); the model only describes the
// payload. Nothing is written, no status / money is touched. Only aggregates (and scrubbed short review snippets) leave the server.

const MAX_ROWS = 20000;

export type ForecastResponse = MetricSummaryResult & { series: ForecastMetrics | null };
export type AnomalyResponse = MetricSummaryResult & { anomalies: AnomalyMetrics | null };
export type SentimentResponse = MetricSummaryResult & { stats: SentimentMetrics | null };

export interface AnomalyMetrics {
  windowDays: number;
  sigma: number;
  anomalyCount: number;
  metrics: DailyStats[];
  securityEventsByType: { label: string; count: number }[];
}

const forecastAllow: AllowRule = {
  currency: 'string', monthsWithData: 'number', inflowNextMonthEstimate: 'number', inflowTrendBasedOnMonths: 'number',
  months: [{ month: 'string', inflow: 'number', outflow: 'number', inflowChangePercent: 'number' }],
};
const anomalyAllow: AllowRule = {
  windowDays: 'number', sigma: 'number', anomalyCount: 'number',
  metrics: [{ key: 'string', totalEvents: 'number', evaluated: 'boolean', mean: 'number', stdDev: 'number', anomalyDays: [{ date: 'string', count: 'number', zScore: 'number' }] }],
  securityEventsByType: [{ label: 'string', count: 'number' }],
};
const sentimentAllow: AllowRule = {
  totalReviews: 'number', averageRating: 'number', withCommentCount: 'number', positivePercent: 'number', negativePercent: 'number',
  distribution: [{ stars: 'number', count: 'number', percent: 'number' }], commentSnippets: ['text'],
};

export class AdminAiSummariesService {
  constructor(private readonly engine: Pick<MetricSummaryEngine, 'summarise'> = metricSummaryEngine, private readonly now: () => Date = () => new Date()) {}

  async forecast(adminId: string): Promise<ForecastResponse> {
    const now = this.now();
    const months = lastCompleteMonths(now, FORECAST_WINDOW_MONTHS);
    const from = new Date(`${months[0]}-01T00:00:00.000Z`);
    const to = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
    const [deposits, withdrawals] = await Promise.all([
      prisma.walletTransaction.findMany({ where: { type: 'DEPOSIT', status: 'COMPLETED', createdAt: { gte: from, lt: to } }, select: { amount: true, currency: true, createdAt: true }, take: MAX_ROWS }),
      prisma.withdrawal.findMany({ where: { status: 'COMPLETED', createdAt: { gte: from, lt: to } }, select: { amount: true, currency: true, createdAt: true }, take: MAX_ROWS }),
    ]);
    // One currency only (never sum across currencies): the one with the most completed deposits, else the most withdrawals.
    const tally = new Map<string, number>();
    for (const r of [...deposits, ...withdrawals]) tally.set(r.currency, (tally.get(r.currency) ?? 0) + 1);
    const currency = [...tally.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
    const pick = (rows: { amount: number; currency: string; createdAt: Date }[]) => rows.filter((r) => r.currency === currency).map((r) => ({ amount: r.amount, at: r.createdAt }));
    const metrics = buildForecastMetrics(pick(deposits), pick(withdrawals), months, currency);
    const result = await this.engine.summarise({
      feature: 'admin-forecast', userId: adminId, metrics, allow: forecastAllow,
      paths: ['months', 'monthsWithData'], minUsedPaths: 2, hasEnoughData: (p) => (p?.monthsWithData ?? 0) >= FORECAST_MIN_MONTHS,
      system: 'أنت محلل مالي للمنصة. لخّص حركة الأموال الشهرية الفعلية (الإيداعات المكتملة كتدفق وارد، والسحوبات المكتملة كتدفق صادر) واتجاهها اعتماداً على الأرقام المرسلة فقط. '
        + 'إن وُجد inflowNextMonthEstimate فاذكره كتقدير مشتق من الاتجاه الخطي وليس توقعاً مؤكداً؛ وإن كان null فلا تذكر أي توقع. لا تذكر نسبة ثقة أو احتمالاً.',
    });
    return { ...result, series: result.status === 'NOT_ENOUGH_DATA' ? null : metrics };
  }

  async anomaly(adminId: string): Promise<AnomalyResponse> {
    const now = this.now();
    const days = lastDays(now, ANOMALY_WINDOW_DAYS);
    const from = new Date(`${days[0]}T00:00:00.000Z`);
    const [withdrawals, disputes, logins, security] = await Promise.all([
      prisma.withdrawal.findMany({ where: { createdAt: { gte: from } }, select: { createdAt: true }, take: MAX_ROWS }),
      prisma.dispute.findMany({ where: { createdAt: { gte: from } }, select: { createdAt: true }, take: MAX_ROWS }),
      prisma.accountAuditLog.findMany({ where: { eventType: 'LOGIN_REJECTED', occurredAt: { gte: from } }, select: { occurredAt: true }, take: MAX_ROWS }),
      prisma.accountAuditLog.findMany({ where: { severity: { in: ['WARNING', 'CRITICAL'] }, occurredAt: { gte: from } }, select: { occurredAt: true, eventType: true }, take: MAX_ROWS }),
    ]);
    const stats = [
      dailyAnomalyStats('withdrawalRequestsPerDay', withdrawals.map((r) => r.createdAt), days),
      dailyAnomalyStats('disputesOpenedPerDay', disputes.map((r) => r.createdAt), days),
      dailyAnomalyStats('failedLoginsPerDay', logins.map((r) => r.occurredAt), days),
      dailyAnomalyStats('securityWarningEventsPerDay', security.map((r) => r.occurredAt), days),
    ];
    const metrics: AnomalyMetrics = {
      windowDays: ANOMALY_WINDOW_DAYS, sigma: 3,
      anomalyCount: stats.reduce((s, m) => s + m.anomalyDays.length, 0),
      metrics: stats,
      securityEventsByType: topCounts(security.map((r) => r.eventType ?? '')),
    };
    const result = await this.engine.summarise({
      feature: 'admin-anomaly', userId: adminId, metrics, allow: anomalyAllow,
      paths: ['metrics', 'windowDays'], minUsedPaths: 2, hasEnoughData: (p) => Array.isArray(p?.metrics) && p.metrics.some((m: any) => m?.evaluated === true),
      system: 'أنت محلل أمني ومالي للمنصة. لخّص العمليات غير المعتادة خلال آخر أيام النافذة اعتماداً على الإحصاءات المرسلة فقط (المتوسط والانحراف المعياري والأيام التي تجاوزت الحد). '
        + 'عدد الحالات غير المعتادة هو anomalyCount كما هو؛ لا تحسب عدداً آخر ولا تُسمِّ أشخاصاً. إن كان anomalyCount = 0 فاذكر أن لا شذوذ إحصائياً ظاهراً. المقاييس التي evaluated=false لا بيانات كافية لها.',
    });
    return { ...result, anomalies: result.status === 'NOT_ENOUGH_DATA' ? null : metrics };
  }

  async sentiment(adminId: string): Promise<SentimentResponse> {
    const where = { reviewerRole: 'CLIENT', rating: { gt: 0 } };
    const [ratingRows, withCommentCount, commentRows] = await Promise.all([
      prisma.review.findMany({ where, select: { rating: true }, take: MAX_ROWS }),
      prisma.review.count({ where: { ...where, comment: { not: null }, NOT: { comment: '' } } }),
      prisma.review.findMany({ where: { ...where, comment: { not: null }, NOT: { comment: '' } }, orderBy: { createdAt: 'desc' }, select: { comment: true }, take: SENTIMENT_MAX_SNIPPETS }),
    ]);
    const snippets = commentRows.map((r) => scrubFreeText(r.comment, SENTIMENT_SNIPPET_CHARS)).filter((s) => s.length > 0);
    const metrics = buildSentimentMetrics(ratingRows.map((r) => r.rating), withCommentCount, snippets);
    const result = await this.engine.summarise({
      feature: 'admin-sentiment', userId: adminId, metrics, allow: sentimentAllow,
      paths: ['totalReviews', 'distribution'], minUsedPaths: 2, hasEnoughData: (p) => (p?.totalReviews ?? 0) >= SENTIMENT_MIN_REVIEWS,
      system: 'أنت محلل جودة. لخّص انطباع العملاء عن مقدمي الخدمة اعتماداً على توزيع التقييمات والنسب المرسلة (positivePercent / negativePercent / distribution كما هي، لا تحسب نسباً بنفسك) '
        + 'وعلى مقتطفات التعليقات المرسلة لاستخلاص المحاور المتكررة. لا تنسب رأياً لشخص بعينه، ولا تذكر أن المقتطفات تمثل كل التعليقات.',
    });
    return { ...result, stats: result.status === 'NOT_ENOUGH_DATA' ? null : metrics };
  }
}

export const adminAiSummariesService = new AdminAiSummariesService();
