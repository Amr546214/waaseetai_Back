import { AccountType } from '@prisma/client';
import { prisma } from '../config/db';
import { CLIENT_LEVELS } from '../config/levels.config';
import { AppError } from '../utils/app-error';
import { computeClientCompletion } from '../utils/completion-calculators';
import { round2 } from '../utils/money';
import { getClientLevelDetails } from './gamification.service';

/** Read-only company summary. No budget/employee-approval workflow is created
 * here: unavailable measures are null, rather than fictitious zero balances.
 * Spend means stages approved this calendar quarter, excluding escrow holds.
 */
export async function getClientCompanyDashboard(userId: string) {
  const user = await prisma.user.findUnique({ where: { id: userId }, include: { clientProfile: true } });
  if (!user) throw new AppError('المستخدم غير موجود', 404);
  if (user.accountType !== AccountType.CLIENT_COMPANY) throw new AppError('هذه الميزة متاحة لحسابات الشركات فقط', 403);

  const now = new Date();
  const quarterMonth = Math.floor(now.getUTCMonth() / 3) * 3;
  const since = new Date(Date.UTC(now.getUTCFullYear(), quarterMonth, 1));
  const until = new Date(Date.UTC(now.getUTCFullYear(), quarterMonth + 3, 1));
  const employeeWhere = { companyOwnerId: userId, memberType: 'EMPLOYEE' as const };
  // Ownership is enforced on both sides of the assignment, including legacy rows.
  const teamProjectWhere = {
    clientId: userId,
    status: 'IN_PROGRESS' as const,
    assignedEmployee: { is: employeeWhere }
  };
  const [activeEmployees, employeeTotal, activeTeamProjects, activeMembers, spend, level] = await Promise.all([
    prisma.companyTeamMember.count({ where: { ...employeeWhere, status: 'ACTIVE' } }),
    prisma.companyTeamMember.count({ where: employeeWhere }),
    prisma.project.count({ where: teamProjectWhere }),
    prisma.project.findMany({ where: teamProjectWhere, select: { assignedEmployeeId: true }, distinct: ['assignedEmployeeId'] }),
    prisma.projectStage.aggregate({
      where: { status: 'APPROVED', approvedAt: { gte: since, lt: until }, contract: { clientId: userId } },
      _sum: { amount: true }
    }),
    getClientLevelDetails(userId)
  ]);
  const profile = user.clientProfile;
  const completion = computeClientCompletion({ user, clientProfile: profile ?? {} });
  const next = CLIENT_LEVELS.find(item => item.level === level.currentLevel.index + 1);
  return {
    companyName: profile?.companyName?.trim() || [profile?.firstName ?? user.firstName, profile?.lastName ?? user.lastName].filter(Boolean).join(' '),
    companyBadge: profile?.industry ?? '',
    profileCompletionPercent: completion,
    kpis: {
      remainingBudget: null,
      activeEmployees,
      activeEmployeesTotal: employeeTotal,
      quarterSpend: round2(spend._sum.amount ?? 0),
      activeTeamProjects,
      activeTeamProjectsMembers: activeMembers.length,
      pendingYourApproval: null
    },
    quarterBudget: null,
    actionCards: [],
    levelProgress: {
      points: level.currentStats.points,
      nextLevelPoints: next?.minPoints ?? Math.max(1, level.currentStats.points),
      currentLevel: level.currentLevel.index,
      levelLabel: level.currentLevel.title
    },
    walletBalance: round2(Number(user.walletBalance ?? 0)),
    employeeSpending: [],
    aiInsight: '',
    pendingApprovals: [],
    recentTeamRequests: [],
    recentActivity: [],
    pendingProfileCompletionRequired: completion < 100
  };
}
