import type { AllowRule } from '../llm/llm.payload';

// AI insights for a marketer over their OWN real aggregates: per-channel metrics, referral counts by status, approved commissions and a
// 30-day referral trend. Numbers and channel labels only: no referral names / emails / phones / ids ever reach the model.

export const MARKETER_INSIGHTS_AI_FEATURE = 'marketer-insights';
/** With no channel metrics at all, fewer referrals than this -> NOT_ENOUGH_DATA (the model is not called). */
export const MARKETER_INSIGHTS_MIN_REFERRALS = 3;
export const MARKETER_TREND_DAYS = 30;

export const MARKETER_INSIGHTS_ALLOW: AllowRule = {
  channels: [{ channel: 'string', visitors: 'number', conversionPercentage: 'number' }],
  referrals: { total: 'number', byStatus: [{ status: 'string', count: 'number' }], last30Days: 'number', previous30Days: 'number' },
  commissions: { approvedCount: 'number', approvedTotal: 'number' },
};

export const MARKETER_INSIGHTS_PATHS = ['channels', 'referrals.byStatus', 'referrals.total', 'commissions.approvedTotal'];

export const MARKETER_INSIGHTS_SYSTEM = `أنت مساعد يلخّص أداء الوسيط التسويقي نفسه اعتماداً على الأرقام المرسلة فقط: أداء كل قناة (الزوار ونسبة التحويل)، أعداد الإحالات حسب الحالة، العمولات المعتمدة، واتجاه الإحالات في آخر 30 يوماً مقابل الـ30 التي قبلها إن وُجد.
المطلوب: summary قصير، وobservations عمّا تُظهره الأرقام، وrecommendations تنتج حصراً من هذه الأرقام (مثل أي قناة تستحق التركيز ولماذا).
ممنوع: مقارنة مع وسطاء آخرين أو السوق، أي وعد أو توقع بأرباح، وأي نصيحة مالية.`;

export interface MarketerInsightsRaw {
  channels: { channel: string; visitors: number; conversionPercentage: number }[];
  referralsByStatus: { status: string; count: number }[];
  referralsLast30Days: number;
  referralsPrevious30Days: number;
  approvedCommissionAmounts: number[];
}

/** Missing is null / empty, never 0. */
export function buildMarketerInsightsMetrics(raw: MarketerInsightsRaw) {
  const byStatus = raw.referralsByStatus.filter((s) => s.count > 0);
  const total = byStatus.reduce((a, s) => a + s.count, 0);
  const approvedCount = raw.approvedCommissionAmounts.length;
  return {
    channels: raw.channels.map((c) => ({ channel: c.channel, visitors: c.visitors, conversionPercentage: c.conversionPercentage })),
    referrals: {
      total: total > 0 ? total : null,
      byStatus,
      last30Days: total > 0 ? raw.referralsLast30Days : null,
      previous30Days: total > 0 ? raw.referralsPrevious30Days : null,
    },
    commissions: {
      approvedCount: approvedCount > 0 ? approvedCount : null,
      approvedTotal: approvedCount > 0 ? raw.approvedCommissionAmounts.reduce((a, b) => a + b, 0) : null,
    },
  };
}

export const marketerHasEnoughData = (p: any): boolean =>
  (Array.isArray(p?.channels) && p.channels.length > 0) || (typeof p?.referrals?.total === 'number' && p.referrals.total >= MARKETER_INSIGHTS_MIN_REFERRALS);
