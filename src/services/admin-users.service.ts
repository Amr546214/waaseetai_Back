import { prisma } from '../config/db';
import { AccountType, UserStatus, RiskLevel, Prisma } from '@prisma/client';

export interface GetUsersQueryParams {
  page?: number;
  limit?: number;
  search?: string;
  accountType?: string;
  status?: string;
  financialRange?: string;
  rating?: string;
  joinedDate?: string;
  riskLevel?: string;
  lastActive?: string;
  sortBy?: string;
  sortOrder?: 'asc' | 'desc';
}

function formatRelativeTime(date?: Date | null): string {
  if (!date) return 'غير محدد';
  const now = new Date();
  const diffMs = now.getTime() - new Date(date).getTime();
  const diffMins = Math.floor(diffMs / (1000 * 60));
  const diffHours = Math.floor(diffMs / (1000 * 60 * 60));
  const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));

  if (diffMins < 1) return 'الآن';
  if (diffMins < 60) return `قبل ${diffMins} دقيقة`;
  if (diffHours < 24) return `قبل ${diffHours} ${diffHours === 1 ? 'ساعة' : diffHours === 2 ? 'ساعتين' : 'ساعات'}`;
  if (diffDays === 1) return 'أمس';
  if (diffDays === 2) return 'قبل يومين';
  if (diffDays < 30) return `قبل ${diffDays} أيام`;
  const diffMonths = Math.floor(diffDays / 30);
  return `قبل ${diffMonths} ${diffMonths === 1 ? 'شهر' : 'أشهر'}`;
}

function mapAccountTypeToTab(type: AccountType): string {
  switch (type) {
    case AccountType.CLIENT_INDIVIDUAL: return 'sk-ind';
    case AccountType.CLIENT_COMPANY: return 'sk-co';
    case AccountType.PROVIDER_INDIVIDUAL: return 'pr-ind';
    case AccountType.PROVIDER_COMPANY: return 'pr-co';
    case AccountType.MARKETING_BROKER: return 'affiliate';
    case AccountType.ADMIN:
    case AccountType.SUPER_ADMIN:
    case AccountType.EMPLOYEE: return 'admin';
    default: return 'all';
  }
}

function mapTabToAccountTypeWhere(tab: string): Prisma.EnumAccountTypeFilter | AccountType | { in: AccountType[]; not?: AccountType } | { not: AccountType } | undefined {
  switch (tab) {
    case 'sk-ind': return AccountType.CLIENT_INDIVIDUAL;
    case 'sk-co': return AccountType.CLIENT_COMPANY;
    case 'pr-ind': return AccountType.PROVIDER_INDIVIDUAL;
    case 'pr-co': return AccountType.PROVIDER_COMPANY;
    case 'affiliate': return AccountType.MARKETING_BROKER;
    case 'admin': return { in: [AccountType.ADMIN, AccountType.EMPLOYEE] };
    default:
      if (Object.values(AccountType).includes(tab as AccountType) && tab !== AccountType.SUPER_ADMIN) {
        return tab as AccountType;
      }
      return { not: AccountType.SUPER_ADMIN };
  }
}

function getTypeMeta(type: AccountType) {
  switch (type) {
    case AccountType.CLIENT_INDIVIDUAL:
      return { tab: 'sk-ind', label: 'طالب فرد', bg: 'rgba(43,212,199,.10)', color: '#2BD4C7' };
    case AccountType.CLIENT_COMPANY:
      return { tab: 'sk-co', label: 'طالب شركة', bg: 'rgba(255,180,0,.10)', color: '#D98A0B' };
    case AccountType.PROVIDER_INDIVIDUAL:
      return { tab: 'pr-ind', label: 'مقدم فرد', bg: 'rgba(43,127,255,.10)', color: '#5DA0FF' };
    case AccountType.PROVIDER_COMPANY:
      return { tab: 'pr-co', label: 'مقدم شركة', bg: 'rgba(123,47,190,.10)', color: '#A56BE0' };
    case AccountType.MARKETING_BROKER:
      return { tab: 'affiliate', label: 'وسيط', bg: 'rgba(15,169,154,.10)', color: '#0FA99A' };
    case AccountType.ADMIN:
    case AccountType.SUPER_ADMIN:
    case AccountType.EMPLOYEE:
      return { tab: 'admin', label: 'إداري', bg: 'rgba(255,180,0,.10)', color: '#FFB400' };
    default:
      return { tab: 'all', label: 'مستخدم', bg: 'rgba(255,255,255,.10)', color: '#FFFFFF' };
  }
}

const AVATAR_GRADIENTS = [
  'linear-gradient(135deg,#2BD4C7,#2B7FFF)',
  'linear-gradient(135deg,#A56BE0,#5DA0FF)',
  'linear-gradient(135deg,#FFB400,#FF8C69)',
  'linear-gradient(135deg,#FF8C69,#A56BE0)',
  'linear-gradient(135deg,#2BD4C7,#0FA99A)',
  'linear-gradient(135deg,#5DA0FF,#2BD4C7)'
];

export class AdminUsersService {

  async getStats() {
    const nonSuperAdminWhere: Prisma.UserWhereInput = { accountType: { not: AccountType.SUPER_ADMIN } };

    const totalUsers = await prisma.user.count({ where: nonSuperAdminWhere });
    const activeUsers = await prisma.user.count({ where: { status: UserStatus.ACTIVE, ...nonSuperAdminWhere } });
    const suspendedCount = await prisma.user.count({ where: { status: { in: [UserStatus.SUSPENDED, UserStatus.SUSPENDED_REVIEW] }, ...nonSuperAdminWhere } });
    const pendingReviewCount = await prisma.user.count({ where: { status: UserStatus.SUSPENDED_REVIEW, ...nonSuperAdminWhere } });

    const now = new Date();
    const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
    const sixtyDaysAgo = new Date(now.getTime() - 60 * 24 * 60 * 60 * 1000);
    const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
    const fourteenDaysAgo = new Date(now.getTime() - 14 * 24 * 60 * 60 * 1000);

    const [usersThisMonth, usersPrevMonth, activeThisMonth, newThisWeek, newPrevWeek, gmvAggregation] = await Promise.all([
      prisma.user.count({ where: { createdAt: { gte: thirtyDaysAgo }, ...nonSuperAdminWhere } }),
      prisma.user.count({ where: { createdAt: { gte: sixtyDaysAgo, lt: thirtyDaysAgo }, ...nonSuperAdminWhere } }),
      prisma.user.count({ where: { status: UserStatus.ACTIVE, lastActiveAt: { gte: thirtyDaysAgo }, ...nonSuperAdminWhere } }),
      prisma.user.count({ where: { createdAt: { gte: sevenDaysAgo }, ...nonSuperAdminWhere } }),
      prisma.user.count({ where: { createdAt: { gte: fourteenDaysAgo, lt: sevenDaysAgo }, ...nonSuperAdminWhere } }),
      prisma.user.aggregate({ _sum: { totalGmvAmount: true }, where: nonSuperAdminWhere })
    ]);

    const totalGmv = Number(gmvAggregation._sum.totalGmvAmount || 0);

    const monthlyGrowth = usersPrevMonth > 0
      ? (((usersThisMonth - usersPrevMonth) / usersPrevMonth) * 100).toFixed(1)
      : usersThisMonth > 0 ? '100.0' : '0.0';

    const activeRatio = totalUsers > 0
      ? ((activeUsers / totalUsers) * 100).toFixed(1)
      : '0.0';

    const weeklyGrowth = newPrevWeek > 0
      ? (((newThisWeek - newPrevWeek) / newPrevWeek) * 100).toFixed(1)
      : newThisWeek > 0 ? '100.0' : '0.0';

    // Real AccountType counts aggregated directly from database (excluding SUPER_ADMIN)
    const typeGroup = await prisma.user.groupBy({
      by: ['accountType'],
      where: nonSuperAdminWhere,
      _count: { _all: true }
    });

    const tabCounts: Record<string, number> = {
      all: totalUsers,
      'sk-ind': 0,
      'sk-co': 0,
      'pr-ind': 0,
      'pr-co': 0,
      affiliate: 0,
      admin: 0
    };

    typeGroup.forEach(g => {
      const tab = mapAccountTypeToTab(g.accountType);
      tabCounts[tab] = (tabCounts[tab] || 0) + g._count._all;
    });

    return {
      totalUsers: {
        count: totalUsers,
        growth: `${Number(monthlyGrowth) >= 0 ? '+' : ''}${monthlyGrowth}% هذا الشهر`
      },
      activeThisMonth: {
        count: activeUsers,
        ratio: `${activeRatio}% من الإجمالي`
      },
      suspendedCount: {
        count: suspendedCount,
        pendingReview: pendingReviewCount
      },
      newThisWeek: {
        count: newThisWeek,
        growth: `${Number(weeklyGrowth) >= 0 ? '+' : ''}${weeklyGrowth}% من الأسبوع الماضي`
      },
      totalGmvAmount: totalGmv,
      tabCounts
    };
  }

  private buildWhereClause(params: GetUsersQueryParams): Prisma.UserWhereInput {
    const where: Prisma.UserWhereInput = {
      accountType: { not: AccountType.SUPER_ADMIN }
    };

    // Search filter
    if (params.search && params.search.trim() !== '') {
      const query = params.search.trim();
      where.OR = [
        { accountHolderName: { contains: query, mode: 'insensitive' } },
        { firstName: { contains: query, mode: 'insensitive' } },
        { lastName: { contains: query, mode: 'insensitive' } },
        { email: { contains: query, mode: 'insensitive' } },
        { phoneNumber: { contains: query, mode: 'insensitive' } }
      ];
    }

    // Account Type Filter
    if (params.accountType && params.accountType !== 'ALL' && params.accountType !== 'all') {
      const accWhere = mapTabToAccountTypeWhere(params.accountType);
      if (accWhere) {
        where.accountType = accWhere as any;
      }
    }

    // Status Filter
    if (params.status && params.status !== 'ALL' && params.status !== 'all') {
      const uppercaseStatus = params.status.toUpperCase();
      if (Object.values(UserStatus).includes(uppercaseStatus as UserStatus)) {
        where.status = uppercaseStatus as UserStatus;
      }
    }

    // Risk Level Filter
    if (params.riskLevel && params.riskLevel !== 'ALL' && params.riskLevel !== 'all') {
      const uppercaseRisk = params.riskLevel.toUpperCase();
      if (Object.values(RiskLevel).includes(uppercaseRisk as RiskLevel)) {
        where.aiRiskLevel = uppercaseRisk as RiskLevel;
      }
    }

    // Financial Range Filter
    if (params.financialRange && params.financialRange !== 'ALL' && params.financialRange !== 'all') {
      switch (params.financialRange) {
        case 'UNDER_5K':
        case '<5K':
          where.totalGmvAmount = { lt: 5000 };
          break;
        case '5K_TO_50K':
        case '5K–50K':
        case '5K-50K':
          where.totalGmvAmount = { gte: 5000, lte: 50000 };
          break;
        case 'OVER_50K':
        case '>50K':
          where.totalGmvAmount = { gt: 50000 };
          break;
      }
    }

    // Rating Filter
    if (params.rating && params.rating !== 'ALL' && params.rating !== 'all') {
      switch (params.rating) {
        case '4.5_PLUS':
          where.ratingAverage = { gte: 4.5 };
          break;
        case '4_PLUS':
          where.ratingAverage = { gte: 4.0 };
          break;
        case 'UNDER_4':
          where.ratingAverage = { lt: 4.0 };
          break;
      }
    }

    // Joined Date Filter
    if (params.joinedDate && params.joinedDate !== 'ALL' && params.joinedDate !== 'all') {
      const now = new Date();
      if (params.joinedDate === 'THIS_MONTH') {
        const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
        where.createdAt = { gte: startOfMonth };
      } else if (params.joinedDate === 'LAST_3_MONTHS') {
        const threeMonthsAgo = new Date(now.getTime() - 90 * 24 * 60 * 60 * 1000);
        where.createdAt = { gte: threeMonthsAgo };
      }
    }

    // Last Active Filter
    if (params.lastActive && params.lastActive !== 'ALL' && params.lastActive !== 'all') {
      const now = new Date();
      if (params.lastActive === 'TODAY') {
        const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
        where.lastActiveAt = { gte: startOfToday };
      } else if (params.lastActive === 'THIS_WEEK') {
        const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
        where.lastActiveAt = { gte: sevenDaysAgo };
      } else if (params.lastActive === 'UNDER_30_DAYS') {
        const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
        where.lastActiveAt = { gte: thirtyDaysAgo };
      }
    }

    return where;
  }

  async getUsers(params: GetUsersQueryParams) {
    const page = Math.max(Number(params.page) || 1, 1);
    const limit = Math.min(Math.max(Number(params.limit) || 15, 1), 100);
    const skip = (page - 1) * limit;

    const where = this.buildWhereClause(params);

    const sortBy = params.sortBy || 'createdAt';
    const sortOrder = params.sortOrder || 'desc';

    const [total, rawUsers] = await Promise.all([
      prisma.user.count({ where }),
      prisma.user.findMany({
        where,
        skip,
        take: limit,
        orderBy: { [sortBy]: sortOrder },
        include: {
          clientProfile: true,
          providerProfile: {
            include: {
              providerSpecialties: {
                include: {
                  specialty: true
                }
              },
              accreditationSubmissions: true
            }
          },
          affiliateProfile: true
        }
      })
    ]);

    const formattedUsers = rawUsers.map((u, index) => {
      const name = u.accountHolderName || `${u.firstName} ${u.lastName}`.trim() || u.email;
      const typeMeta = getTypeMeta(u.accountType);
      const av = name ? name.charAt(0).toUpperCase() : u.email.charAt(0).toUpperCase();
      const avBg = AVATAR_GRADIENTS[index % AVATAR_GRADIENTS.length];

      const formattedFinancial = Number(u.totalGmvAmount || 0).toLocaleString('en-US');

      // Extract real specialty list if provider profile exists
      const specialtiesList = u.providerProfile?.providerSpecialties
        ?.map(ps => ps.specialty?.nameAr || ps.specialty?.name || '')
        .filter(Boolean)
        .join(', ') || u.providerProfile?.headline || '-';

      return {
        id: u.id,
        name,
        email: u.email,
        phoneNumber: u.phoneNumber,
        accountType: u.accountType,
        type: typeMeta.tab,
        typeLabel: typeMeta.label,
        typeBg: typeMeta.bg,
        typeColor: typeMeta.color,
        status: u.status.toLowerCase(),
        statusOriginal: u.status,
        last: formatRelativeTime(u.lastActiveAt),
        lastActiveAt: u.lastActiveAt,
        projects: u.completedProjectsCount || 0,
        risk: (u.aiRiskLevel || 'LOW').toLowerCase(),
        aiRiskScore: u.aiRiskScore || 10,
        aiSuspiciousNotes: u.aiSuspiciousNotes,
        av,
        avBg,
        spending: formattedFinancial,
        revenue: formattedFinancial,
        monthlyBudget: formattedFinancial,
        pendingCommission: formattedFinancial,
        rating: u.ratingAverage ? u.ratingAverage.toFixed(1) : '0.0',
        level: u.tierLevel || 'Bronze',
        requests: u.completedProjectsCount || 0,
        lastReq: formatRelativeTime(u.lastActiveAt),
        manager: u.clientProfile?.companyName || `${u.firstName} ${u.lastName}`.trim() || '-',
        teamSize: u.clientProfile?.companySize || '1',
        specialty: u.providerProfile?.headline || specialtiesList,
        providerCount: '1',
        specialties: specialtiesList,
        activeProjects: String(u.completedProjectsCount || 0),
        totalReferrals: String(u.affiliateProfile ? u.completedProjectsCount : 0),
        affiliateLevel: '1',
        role: u.accountType === AccountType.SUPER_ADMIN ? 'Super Admin' : u.accountType === AccountType.ADMIN ? 'مدير' : 'موظف',
        tasksCount: '0',
        createdAt: u.createdAt,
        clientProfile: u.clientProfile,
        providerProfile: u.providerProfile,
        affiliateProfile: u.affiliateProfile
      };
    });

    return {
      users: formattedUsers,
      meta: {
        total,
        page,
        limit,
        totalPages: Math.ceil(total / limit) || 1
      }
    };
  }

  async updateUserStatus(id: string, status: string) {
    const uppercaseStatus = status.toUpperCase() as UserStatus;
    if (!Object.values(UserStatus).includes(uppercaseStatus)) {
      throw new Error(`Invalid status: ${status}`);
    }

    const updated = await prisma.user.update({
      where: { id },
      data: { status: uppercaseStatus }
    });

    return updated;
  }

  async deleteUser(id: string) {
    return await prisma.$transaction(async (tx) => {
      // 1. Unassign provider from any projects to prevent constraint errors
      await tx.project.updateMany({
        where: { providerId: id },
        data: { providerId: null }
      });

      // 2. Delete messages sent by the user
      await tx.message.deleteMany({
        where: { senderId: id }
      });

      // 3. Delete conversations where user is client or provider
      await tx.conversation.deleteMany({
        where: { OR: [{ clientId: id }, { providerId: id }] }
      });

      // 4. Delete contracts where user is client or provider
      await tx.contract.deleteMany({
        where: { OR: [{ clientId: id }, { providerId: id }] }
      });

      // 5. Finally, delete the user (other relations like profile, projects, etc. have cascade enabled)
      const deletedUser = await tx.user.delete({
        where: { id }
      });

      return deletedUser;
    });
  }

  async exportCsv(params: GetUsersQueryParams): Promise<string> {
    const where = this.buildWhereClause(params);
    const BATCH_SIZE = 1000;
    let page = 0;
    let hasMore = true;
    const rows: string[] = [];

    const headers = [
      'User ID',
      'Name',
      'Email',
      'Phone Number',
      'Account Type',
      'Status',
      'Risk Level',
      'Risk Score',
      'Total GMV (SAR)',
      'Completed Projects',
      'Rating Average',
      'Tier Level',
      'Last Active',
      'Created At'
    ];

    while (hasMore) {
      const users = await prisma.user.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: page * BATCH_SIZE,
        take: BATCH_SIZE,
        select: {
          id: true,
          firstName: true,
          lastName: true,
          accountHolderName: true,
          email: true,
          phoneNumber: true,
          accountType: true,
          status: true,
          aiRiskLevel: true,
          aiRiskScore: true,
          totalGmvAmount: true,
          completedProjectsCount: true,
          ratingAverage: true,
          tierLevel: true,
          lastActiveAt: true,
          createdAt: true
        }
      });

      if (users.length === 0) {
        hasMore = false;
        break;
      }

      for (const u of users) {
        const name = u.accountHolderName || `${u.firstName} ${u.lastName}`.trim();
        rows.push([
          `"${u.id}"`,
          `"${name.replace(/"/g, '""')}"`,
          `"${u.email}"`,
          `"${u.phoneNumber || ''}"`,
          `"${u.accountType}"`,
          `"${u.status}"`,
          `"${u.aiRiskLevel}"`,
          u.aiRiskScore,
          Number(u.totalGmvAmount || 0).toFixed(2),
          u.completedProjectsCount,
          u.ratingAverage || 0,
          `"${u.tierLevel || 'Bronze'}"`,
          `"${u.lastActiveAt ? u.lastActiveAt.toISOString() : ''}"`,
          `"${u.createdAt.toISOString()}"`
        ].join(','));
      }

      if (users.length < BATCH_SIZE) {
        hasMore = false;
      } else {
        page++;
      }
    }

    return [headers.join(','), ...rows].join('\n');
  }
}
