import { prisma } from '../config/db';

/** Reads stored outcomes only; no model invocation and no raw request/response leaves this service. */
export class AdminAiConsoleService {
  constructor(private db = prisma, private clock: () => Date = () => new Date()) {}

  private bounds(days: number) {
    const to = this.clock();
    return { gte: new Date(to.getTime() - days * 86400_000), lt: to };
  }

  async overview(days: number) {
    const createdAt = this.bounds(days);
    const [specialty, errors, models, accreditation, matching] = await this.db.$transaction([
      this.db.aiAuditLog.aggregate({ where: { createdAt }, _count: { id: true }, _sum: { totalTokens: true }, _avg: { latencyMs: true } }),
      this.db.aiAuditLog.count({ where: { createdAt, errorMessage: { not: null } } }),
      this.db.aiAuditLog.groupBy({ by: ['modelVersion'], where: { createdAt }, _count: { id: true }, orderBy: { _count: { id: 'desc' } }, take: 20 }),
      this.db.aiAccreditationAuditLog.count({ where: { evaluatedAt: createdAt } }),
      this.db.proposal.count({ where: { createdAt, aiMatchScore: { not: null } } }),
    ]);
    return {
      days, readAt: this.clock().toISOString(),
      specialtyChecks: specialty._count.id, recordedErrors: errors,
      recordedTokens: specialty._sum.totalTokens, averageLatencyMs: specialty._avg.latencyMs,
      accreditationChecks: accreditation, scoredOffers: matching,
      models: models.map(m => ({ version: m.modelVersion, count: m._count.id })),
    };
  }

  async audit(days: number, page: number, source: 'specialty' | 'accreditation') {
    const since = this.bounds(days);
    const common = { skip: (page - 1) * 20, take: 21 };
    if (source === 'specialty') {
      const rows = await this.db.aiAuditLog.findMany({
        ...common, where: { createdAt: since }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        select: { id: true, providerSpecialtyId: true, modelVersion: true, totalTokens: true, latencyMs: true, createdAt: true },
      });
      return { page, hasNext: page < 10_000 && rows.length > 20, items: rows.slice(0, 20).map(r => ({
        id: r.id, reference: r.providerSpecialtyId, at: r.createdAt.toISOString(),
        model: r.modelVersion, tokens: r.totalTokens, latencyMs: r.latencyMs,
      })) };
    }
    const rows = await this.db.aiAccreditationAuditLog.findMany({
      ...common, where: { evaluatedAt: since }, orderBy: [{ evaluatedAt: 'desc' }, { id: 'desc' }],
      select: { id: true, accreditationSubmissionId: true, promptTokensUsed: true, completionTokensUsed: true, evaluatedAt: true },
    });
    return { page, hasNext: page < 10_000 && rows.length > 20, items: rows.slice(0, 20).map(r => ({
      id: r.id, reference: r.accreditationSubmissionId, at: r.evaluatedAt.toISOString(),
      model: null, tokens: r.promptTokensUsed === null || r.completionTokensUsed === null ? null : r.promptTokensUsed + r.completionTokensUsed,
      latencyMs: null,
    })) };
  }

  async matching(days: number, page: number) {
    const createdAt = this.bounds(days);
    const where = { createdAt, aiMatchScore: { not: null } };
    const [stats, rows] = await this.db.$transaction([
      this.db.proposal.aggregate({ where, _count: { id: true }, _avg: { aiMatchScore: true }, _min: { aiMatchScore: true }, _max: { aiMatchScore: true } }),
      this.db.proposal.findMany({
        where, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], skip: (page - 1) * 20, take: 21,
        select: { id: true, clientRequestId: true, projectId: true, aiMatchScore: true, createdAt: true },
      }),
    ]);
    return {
      page, days, hasNext: page < 10_000 && rows.length > 20,
      count: stats._count.id, average: stats._avg.aiMatchScore, min: stats._min.aiMatchScore, max: stats._max.aiMatchScore,
      items: rows.slice(0, 20).map(r => ({ id: r.id, requestId: r.clientRequestId, projectId: r.projectId, score: r.aiMatchScore, at: r.createdAt.toISOString() })),
    };
  }
}
export const adminAiConsoleService = new AdminAiConsoleService();
