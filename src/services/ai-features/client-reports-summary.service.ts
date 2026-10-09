import type { AllowRule } from '../llm/llm.payload';
import { clientReportsService, type ReportDateRange } from '../client-reports.service';
import { metricSummaryEngine, type MetricSummaryEngine, type MetricSummaryResult } from './metric-summary';

// AI summary of a client's OWN activity for the selected reports period. Metrics come from the SAME aggregation the reports page uses
// (clientReportsService.getReports), reduced to counts / totals / per-specialty numbers. No ids, titles, names or transactions leave the server.

export const CLIENT_REPORTS_AI_FEATURE = 'client-reports-summary';
/** Fewer requests than this in the period -> NOT_ENOUGH_DATA (the model is not called). */
export const CLIENT_REPORTS_MIN_REQUESTS = 3;

export const PERIOD_LABELS_AR: Record<ReportDateRange, string> = {
  month: 'هذا الشهر', '3m': 'آخر 3 أشهر', '6m': 'آخر 6 أشهر', year: 'هذه السنة', all: 'كل الفترات',
};

export const CLIENT_REPORTS_ALLOW: AllowRule = {
  period: 'string',
  totals: { requests: 'number', completed: 'number', active: 'number', published: 'number', cancelled: 'number', totalSpent: 'number', avgRating: 'number', reviewsCount: 'number', disputes: 'number', openDisputes: 'number' },
  acceptanceBySpecialty: [{ specialty: 'string', requests: 'number', acceptanceRatePercent: 'number' }],
};

const PATHS = ['totals.requests', 'totals.completed', 'totals.totalSpent', 'totals.avgRating', 'totals.disputes', 'acceptanceBySpecialty'];

export const CLIENT_REPORTS_SYSTEM = `أنت مساعد يلخّص نشاط العميل نفسه على المنصة خلال الفترة المحددة (period) اعتماداً على الأرقام المرسلة فقط.
المطلوب: summary يلخّص نشاطه في الفترة، وobservations تصف ما تُظهره الأرقام (الطلبات، المكتمل، الإنفاق، التقييم، النزاعات، نسب القبول حسب التخصص)، وrecommendations تنتج حصراً من هذه الأرقام.
ممنوع: أي مقارنة مع السوق أو مع عملاء آخرين، أي وعود أو توقعات بنتائج، وأي نصيحة مالية أو استثمارية.`;

type Reports = Awaited<ReturnType<typeof clientReportsService.getReports>>;

/** Missing is null, never 0. */
const orNull = (n: number | null | undefined, has: boolean): number | null => (has && typeof n === 'number' && Number.isFinite(n) ? n : null);

export function buildClientReportsMetrics(r: Reports, range: ReportDateRange) {
  const requests = r.kpis.totalRequests;
  const completed = r.kpis.completedProjectsCount;
  const reviews = r.kpis.reviewsCount;
  const disputes = r.disputes.counts.all;
  return {
    period: PERIOD_LABELS_AR[range],
    totals: {
      requests: orNull(requests, requests > 0),
      completed: orNull(completed, requests > 0),
      active: orNull(r.orders.counts.active, requests > 0),
      published: orNull(r.orders.counts.published, requests > 0),
      cancelled: orNull(r.orders.counts.cancelled, requests > 0),
      totalSpent: orNull(r.kpis.totalSpent, completed > 0),
      avgRating: orNull(r.kpis.avgRating, reviews > 0),
      reviewsCount: orNull(reviews, reviews > 0),
      disputes: orNull(disputes, disputes > 0),
      openDisputes: orNull(r.disputes.counts.open, disputes > 0),
    },
    acceptanceBySpecialty: r.orders.acceptanceBySpecialty.map((s) => ({ specialty: s.specialty, requests: s.total, acceptanceRatePercent: s.rate })),
  };
}

export async function summariseClientReports(userId: string, range: ReportDateRange, engine: Pick<MetricSummaryEngine, 'summarise'> = metricSummaryEngine): Promise<MetricSummaryResult> {
  const reports = await clientReportsService.getReports(userId, range);
  return engine.summarise({
    feature: CLIENT_REPORTS_AI_FEATURE, userId,
    metrics: buildClientReportsMetrics(reports, range), allow: CLIENT_REPORTS_ALLOW,
    paths: PATHS, minUsedPaths: 1, system: CLIENT_REPORTS_SYSTEM,
    hasEnoughData: (p) => typeof p?.totals?.requests === 'number' && p.totals.requests >= CLIENT_REPORTS_MIN_REQUESTS,
  });
}
