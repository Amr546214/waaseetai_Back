import { prisma } from '../config/db';

// Implementation Batch 7 — replaces sa-security.ts's fully hardcoded
// security event feed (5 fictional events: fake brute-force attempt, fake
// SQL injection attempt, fake admin logins, all with invented IPs/times)
// and fabricated KPIs ("847 محاولات فاشلة", "124 IPs محجوبة", "24,812
// Audit Logs اليوم" — none computed from anything). AccountAuditLog is a
// real, already-populated model (auth.service.ts logs LOGIN_REJECTED,
// session.service.ts logs SESSION_STARTED/REVOKED, provider-profile.
// service.ts logs PASSWORD_CHANGED/OTP_VERIFICATION_REJECTED, etc., each
// with real severity/source/ipAddress/device) — this surfaces that real
// data platform-wide instead of inventing a fake feed. "Blocked IPs" is
// deliberately NOT reintroduced here: there is no real IP-blocking
// mechanism anywhere in the backend, and building one is a new
// infrastructure capability, not something to fake in its place.
export interface SecurityEventItem {
  id: string;
  category: string;
  eventType: string;
  title: string;
  summary: string | null;
  severity: string;
  source: string;
  status: string;
  occurredAt: Date;
  ipAddress: string | null;
  device: string | null;
  actorLabel: string | null;
}

export interface SecurityEventsResult {
  events: SecurityEventItem[];
  kpis: {
    totalEventsToday: number;
    criticalOrWarningToday: number;
    failedLoginAttemptsToday: number;
  };
}

// Replaces sa-risk-center.ts's fully hardcoded `riskAccounts` (fictional
// names/scores/reasons like "عبدالرحمن الدوسري — score 89 — احتيال مالي"),
// `fraudPatterns`, and `blockedIps` — none backed by any real model. There
// is no fraud-detection or IP-blocking system anywhere in the backend, and
// no numeric "risk score" is ever computed for a user (User.aiRiskScore
// exists in the schema but is never written anywhere — see
// admin-users.service.ts). Building real fraud detection or IP blocking is
// a new capability, not something to fake here. This instead surfaces real,
// already-decided admin actions: accounts a human admin has actually
// suspended, plus their real open-dispute counts — no invented score.
export interface FlaggedAccountItem {
  userId: string;
  name: string;
  accountType: string;
  status: string;
  openDisputesAgainst: number;
  openDisputesOpened: number;
}

class AdminSecurityService {
  async getSecurityEvents(limit = 100): Promise<SecurityEventsResult> {
    const startOfDay = new Date();
    startOfDay.setHours(0, 0, 0, 0);

    const [logs, totalEventsToday, criticalOrWarningToday, failedLoginAttemptsToday] = await Promise.all([
      prisma.accountAuditLog.findMany({
        orderBy: { occurredAt: 'desc' },
        take: Math.min(Math.max(limit, 1), 200),
        select: {
          id: true,
          category: true,
          eventType: true,
          title: true,
          summary: true,
          severity: true,
          source: true,
          status: true,
          occurredAt: true,
          ipAddress: true,
          device: true,
          actorLabel: true
        }
      }),
      prisma.accountAuditLog.count({ where: { occurredAt: { gte: startOfDay } } }),
      prisma.accountAuditLog.count({
        where: { occurredAt: { gte: startOfDay }, severity: { in: ['WARNING', 'CRITICAL'] } }
      }),
      prisma.accountAuditLog.count({
        where: { occurredAt: { gte: startOfDay }, eventType: 'LOGIN_REJECTED' }
      })
    ]);

    return {
      events: logs.map((log) => ({
        id: log.id,
        category: log.category,
        eventType: log.eventType || 'SYSTEM_EVENT',
        title: log.title,
        summary: log.summary,
        severity: log.severity || 'INFO',
        source: log.source || 'SYSTEM',
        status: log.status,
        occurredAt: log.occurredAt,
        ipAddress: log.ipAddress,
        device: log.device,
        actorLabel: log.actorLabel
      })),
      kpis: {
        totalEventsToday,
        criticalOrWarningToday,
        failedLoginAttemptsToday
      }
    };
  }

  async getFlaggedAccounts(limit = 50): Promise<FlaggedAccountItem[]> {
    const users = await prisma.user.findMany({
      where: { status: { in: ['SUSPENDED', 'SUSPENDED_REVIEW'] } },
      orderBy: { updatedAt: 'desc' },
      take: Math.min(Math.max(limit, 1), 100),
      select: { id: true, firstName: true, lastName: true, accountType: true, status: true }
    });

    return Promise.all(
      users.map(async (user) => {
        const [openDisputesAgainst, openDisputesOpened] = await Promise.all([
          prisma.dispute.count({ where: { againstUserId: user.id, status: { in: ['OPEN', 'UNDER_REVIEW'] } } }),
          prisma.dispute.count({ where: { openedById: user.id, status: { in: ['OPEN', 'UNDER_REVIEW'] } } })
        ]);
        return {
          userId: user.id,
          name: `${user.firstName} ${user.lastName}`.trim(),
          accountType: user.accountType,
          status: user.status,
          openDisputesAgainst,
          openDisputesOpened
        };
      })
    );
  }
}

export const adminSecurityService = new AdminSecurityService();
