import { prisma } from '../config/db';
import { disconnectUserSockets } from '../utils/socket-registry';
import { AccountType, UserStatus, UserRole, RiskLevel, Prisma, LogCategory, LogStatus, ProjectStatus } from '@prisma/client';
import { AFFILIATE_PROFILE_SAFE_SCALAR_SELECT } from '../utils/affiliate-profile-safe-select.util';
import { AppError, fieldError } from '../utils/app-error';
import { AdminActor, adminAuditData } from './admin-audit';
import { PROVIDER_LEVELS, levelColor } from '../config/levels.config';
import { notificationService } from './notification.service';
import { PROVIDER_ROUTES } from './provider-notifications.service';
import { CLIENT_ROUTES } from './client-notifications.service';
import { NotificationCategory } from '@prisma/client';

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

const ADMIN_TYPES: AccountType[] = [AccountType.ADMIN, AccountType.SUPER_ADMIN, AccountType.EMPLOYEE];
const MANAGEABLE_ROLES: UserRole[] = [UserRole.CLIENT, UserRole.PROVIDER, UserRole.AFFILIATE];
const ALL_ROLES: UserRole[] = [UserRole.CLIENT, UserRole.PROVIDER, UserRole.AFFILIATE, UserRole.ADMIN, UserRole.SUPER_ADMIN];
const ROLE_LABELS: Record<UserRole, string> = { CLIENT: 'طالب خدمة', PROVIDER: 'مقدم خدمة', AFFILIATE: 'وسيط تسويقي', ADMIN: 'إداري', SUPER_ADMIN: 'مدير عام' };
const ROLE_DESCRIPTIONS: Record<UserRole, string> = {
  CLIENT: 'ينشئ الطلبات ويستلم العروض ويمول العقود', PROVIDER: 'يقدّم العروض وينفّذ المشاريع ويسحب أرباحه',
  AFFILIATE: 'يحيل عملاء جدداً ويتتبع عمولاته', ADMIN: 'يدير المستخدمين والاعتمادات والطلبات والمالية من لوحة الإدارة', SUPER_ADMIN: 'كل صلاحيات الإداري، إضافة إلى حذف الحسابات نهائياً وتعديل حالة الحسابات الإدارية'
};
const ADMIN_CAPABILITIES = [
  { key: 'admin-area', label: 'الدخول إلى لوحة الإدارة وإدارة المستخدمين والاعتمادات والطلبات والمالية', admin: true, superAdmin: true },
  { key: 'user-status', label: 'إيقاف / تفعيل حساب مستخدم (مع سبب وسجل تدقيق)', admin: true, superAdmin: true },
  { key: 'user-roles', label: 'تعديل أدوار مستخدم عادي (طالب / مقدم / وسيط)', admin: true, superAdmin: true },
  { key: 'admin-account-status', label: 'تغيير حالة حساب إداري آخر', admin: false, superAdmin: true },
  { key: 'user-delete', label: 'حذف حساب مستخدم نهائياً', admin: false, superAdmin: true }
];
function baseRoleOf(type: AccountType): UserRole | null {
  if (type === AccountType.CLIENT_INDIVIDUAL || type === AccountType.CLIENT_COMPANY) return UserRole.CLIENT;
  if (type === AccountType.PROVIDER_INDIVIDUAL || type === AccountType.PROVIDER_COMPANY) return UserRole.PROVIDER;
  if (type === AccountType.MARKETING_BROKER) return UserRole.AFFILIATE;
  return null;
}

const ACTIVE_PROJECT_STATUSES: ProjectStatus[] = [ProjectStatus.IN_PROGRESS, ProjectStatus.AWAITING_DELIVERY, ProjectStatus.PENDING_APPROVAL];

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
        // The list carries only what its columns show. The whole client / provider / affiliate profile rows (identity document refs, payout
        // e-mail, bank data) are NOT forwarded: they are not needed here and the detail endpoint serves the reviewed fields.
        include: {
          clientProfile: { select: { companyName: true, companySize: true, kycStatus: true, _count: { select: { clientRequests: true } } } },
          providerProfile: { select: { headline: true, kycStatus: true, providerSpecialties: { select: { specialty: { select: { name: true, nameAr: true } } } } } },
          // AffiliateProfile.level is not migrated everywhere yet: select the scalars explicitly (never the default field set).
          affiliateProfile: { select: { currentLevel: true, _count: { select: { referrals: true } } } },
          _count: { select: { clientProjects: { where: { status: { in: ACTIVE_PROJECT_STATUSES } } }, providerProjects: { where: { status: { in: ACTIVE_PROJECT_STATUSES } } } } }
        }
      })
    ]);

    const formattedUsers = rawUsers.map((u: any, index: number) => {
      const name = u.accountHolderName || `${u.firstName} ${u.lastName}`.trim() || u.email;
      const typeMeta = getTypeMeta(u.accountType);
      const av = name ? name.charAt(0).toUpperCase() : u.email.charAt(0).toUpperCase();
      const avBg = AVATAR_GRADIENTS[index % AVATAR_GRADIENTS.length];

      const formattedFinancial = Number(u.totalGmvAmount || 0).toLocaleString('en-US');

      // Extract real specialty list if provider profile exists
      const specialtiesList = u.providerProfile?.providerSpecialties
        ?.map((ps: any) => ps.specialty?.nameAr || ps.specialty?.name || '')
        .filter(Boolean)
        .join(', ') || u.providerProfile?.headline || '-';

      const activeProjects = Number(u._count?.clientProjects ?? 0) + Number(u._count?.providerProjects ?? 0);

      // Only fields that exist in the database are filled. A figure the platform does not record for this account type (budget, pending
      // commission, team size, tasks) is null — the page shows "—", never an invented number.
      return {
        id: u.id,
        name,
        email: u.email,
        phoneNumber: u.phoneNumber,
        accountType: u.accountType,
        roles: u.roles,
        activeRole: u.activeRole,
        type: typeMeta.tab,
        typeLabel: typeMeta.label,
        typeBg: typeMeta.bg,
        typeColor: typeMeta.color,
        status: u.status.toLowerCase(),
        statusOriginal: u.status,
        last: formatRelativeTime(u.lastActiveAt),
        lastActiveAt: u.lastActiveAt,
        projects: u.completedProjectsCount || 0,
        // AI Cleanup Batch 3: `risk` / `aiRiskScore` removed — they were
        // fabricated fallbacks (aiRiskLevel || 'LOW', aiRiskScore || 10) over
        // fields no code path ever writes. The frontend no longer reads them.
        aiSuspiciousNotes: u.aiSuspiciousNotes,
        av,
        avBg,
        spending: formattedFinancial,
        revenue: formattedFinancial,
        monthlyBudget: null,
        pendingCommission: null,
        rating: u.ratingAverage ? u.ratingAverage.toFixed(1) : '0.0',
        level: u.tierLevel || 'Bronze',
        requests: u.clientProfile?._count?.clientRequests ?? 0,
        lastReq: null,
        manager: u.clientProfile?.companyName || null,
        teamSize: u.clientProfile?.companySize || null,
        specialty: u.providerProfile?.headline || specialtiesList,
        providerCount: null,
        specialties: specialtiesList,
        activeProjects: String(activeProjects),
        totalReferrals: String(u.affiliateProfile?._count?.referrals ?? 0),
        affiliateLevel: u.affiliateProfile?.currentLevel ?? null,
        role: u.accountType === AccountType.SUPER_ADMIN ? 'Super Admin' : u.accountType === AccountType.ADMIN ? 'مدير' : 'موظف',
        tasksCount: null,
        kycStatus: u.providerProfile?.kycStatus ?? u.clientProfile?.kycStatus ?? null,
        createdAt: u.createdAt
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

  /**
   * An admin moves an account between ACTIVE and SUSPENDED / SUSPENDED_REVIEW. Rules (all enforced here, not only in the UI):
   *  - the status must be one of those three; PENDING_VERIFICATION is the e-mail verification state and is never set or lifted by hand (409);
   *  - an admin cannot change their own account, and only a SUPER_ADMIN can change another admin account;
   *  - suspending needs a reason (kept in the audit row); the change and its audit row commit together;
   *  - leaving ACTIVE cuts the account's live sockets (HTTP is already refused by requireActiveUser).
   */
  async updateUserStatus(actor: AdminActor, id: string, status: string, reason?: string) {
    const next = String(status || '').toUpperCase() as UserStatus;
    if (!([UserStatus.ACTIVE, UserStatus.SUSPENDED, UserStatus.SUSPENDED_REVIEW] as UserStatus[]).includes(next)) throw fieldError('status', 'حالة الحساب غير صحيحة');
    const cleanReason = String(reason ?? '').trim().slice(0, 500);
    if (next !== UserStatus.ACTIVE && cleanReason.length < 3) throw fieldError('reason', 'سبب الإيقاف مطلوب');
    if (actor.id === id) throw new AppError('لا يمكنك تغيير حالة حسابك بنفسك', 403);

    const target = await prisma.user.findUnique({ where: { id }, select: { id: true, accountType: true, status: true } });
    if (!target) throw new AppError('المستخدم غير موجود', 404);
    if (ADMIN_TYPES.includes(target.accountType)) throw new AppError('وصول موظفي الإدارة يوقفه مالك المنصة من صفحة فريق الإدارة، لا من قائمة المستخدمين', 403);
    if (target.status === UserStatus.PENDING_VERIFICATION) throw new AppError('الحساب لم يؤكد بريده بعد، ولا يمكن تغيير حالته يدوياً', 409);
    if (target.status === next) throw new AppError('الحساب بهذه الحالة بالفعل', 409);

    const updated = await prisma.$transaction(async (tx) => {
      const row = await tx.user.update({ where: { id }, data: { status: next }, select: { id: true, status: true, accountType: true } });
      await tx.accountAuditLog.create({ data: adminAuditData({
        actor, userId: id, category: LogCategory.SECURITY_CHANGE,
        eventType: next === UserStatus.ACTIVE ? 'ACCOUNT_ACTIVATED_BY_ADMIN' : 'ACCOUNT_SUSPENDED_BY_ADMIN',
        title: next === UserStatus.ACTIVE ? 'تفعيل الحساب من الإدارة' : 'إيقاف الحساب من الإدارة',
        summary: next === UserStatus.ACTIVE ? 'أعادت الإدارة تفعيل الحساب' : `أوقفت الإدارة الحساب: ${cleanReason}`,
        status: LogStatus.COMPLETED, severity: next === UserStatus.ACTIVE ? 'INFO' : 'WARNING',
        before: { status: target.status }, after: { status: next }, details: cleanReason ? { reason: cleanReason } : {}
      }) });
      return row;
    });

    // An account that leaves ACTIVE loses its live sockets right away (chat, assistant, assessments); HTTP is already refused by requireActiveUser.
    if (next !== UserStatus.ACTIVE) {
      try { await disconnectUserSockets(id); } catch { /* the status change is already committed */ }
    }
    return updated;
  }

  /**
   * Replaces a non-admin user's roles. activeRole always ends up INSIDE roles: an explicit activeRole must be one of the new roles, and when the
   * current activeRole is revoked it falls back to the account's own base role. The account's base role can never be removed; a role is only
   * added when the account really has that role's profile (PROVIDER needs a provider profile, AFFILIATE an affiliate profile, CLIENT a client
   * profile). ADMIN / SUPER_ADMIN roles are not handled here (admin team management), and an admin cannot edit their own roles.
   */
  async updateUserRoles(actor: AdminActor, id: string, input: { roles: string[]; activeRole?: string }) {
    if (actor.id === id) throw new AppError('لا يمكنك تعديل أدوار حسابك بنفسك', 403);
    const requested = Array.from(new Set((input.roles ?? []).map(r => String(r).toUpperCase())));
    if (requested.length === 0) throw fieldError('roles', 'يجب أن يحتفظ الحساب بدور واحد على الأقل');
    const invalid = requested.filter(r => !MANAGEABLE_ROLES.includes(r as UserRole));
    if (invalid.length) throw fieldError('roles', `دور غير مسموح تعديله من هنا: ${invalid.join(', ')}`);
    const roles = requested as UserRole[];

    const target = await prisma.user.findUnique({
      where: { id },
      select: { id: true, accountType: true, roles: true, activeRole: true, clientProfile: { select: { id: true } }, providerProfile: { select: { id: true } }, affiliateProfile: { select: { id: true } } }
    });
    if (!target) throw new AppError('المستخدم غير موجود', 404);
    if (ADMIN_TYPES.includes(target.accountType)) throw new AppError('أدوار الحسابات الإدارية تُدار من صفحة فريق الإدارة', 403);

    const base = baseRoleOf(target.accountType);
    if (base && !roles.includes(base)) throw fieldError('roles', 'لا يمكن إزالة الدور الأساسي للحساب');
    const hasProfile: Record<string, boolean> = { CLIENT: !!target.clientProfile, PROVIDER: !!target.providerProfile, AFFILIATE: !!target.affiliateProfile };
    const added = roles.filter(r => !target.roles.includes(r));
    const missing = added.filter(r => !hasProfile[r]);
    if (missing.length) throw new AppError(`لا يمكن إضافة دور بلا ملف مفعّل له: ${missing.join(', ')}`, 409);

    let activeRole: UserRole;
    if (input.activeRole !== undefined) {
      const wanted = String(input.activeRole).toUpperCase() as UserRole;
      if (!roles.includes(wanted)) throw fieldError('activeRole', 'الدور النشط يجب أن يكون ضمن الأدوار الجديدة');
      activeRole = wanted;
    } else {
      activeRole = roles.includes(target.activeRole) ? target.activeRole : (base && roles.includes(base) ? base : roles[0]);
    }

    return prisma.$transaction(async (tx) => {
      const row = await tx.user.update({ where: { id }, data: { roles, activeRole }, select: { id: true, roles: true, activeRole: true } });
      await tx.accountAuditLog.create({ data: adminAuditData({
        actor, userId: id, category: LogCategory.SECURITY_CHANGE, eventType: 'ROLES_CHANGED_BY_ADMIN', title: 'تعديل أدوار الحساب من الإدارة',
        summary: `عدّلت الإدارة أدوار الحساب إلى: ${roles.join(', ')} (الدور النشط: ${activeRole})`, severity: 'WARNING',
        before: { roles: target.roles, activeRole: target.activeRole }, after: { roles, activeRole }
      }) });
      return row;
    });
  }

  /**
   * An admin message to ONE user (a notification, delivered through the user's saved channels). Rules: not to admin accounts, not to yourself, 5-500
   * chars. An optional context sends the user straight to the right page and is checked against the data (a REQUEST must be the user's own request,
   * an OFFER must be the user's own offer); without a context the user lands on the home of their ACTIVE role. The send is audit-logged on the user.
   */
  async notifyUser(actor: AdminActor, id: string, input: { message: string; title?: string; context?: { type: 'REQUEST' | 'OFFER'; id: string } }) {
    const message = String(input.message ?? '').trim();
    if (message.length < 5 || message.length > 500) throw fieldError('message', 'نص الرسالة يجب أن يكون بين 5 و500 حرف');
    const title = String(input.title ?? '').trim().slice(0, 80) || 'رسالة من إدارة وسيط';
    if (actor.id === id) throw new AppError('لا يمكنك إرسال رسالة لنفسك', 403);
    const target = await prisma.user.findUnique({ where: { id }, select: { id: true, accountType: true, activeRole: true } });
    if (!target) throw new AppError('المستخدم غير موجود', 404);
    if (ADMIN_TYPES.includes(target.accountType)) throw new AppError('لا يمكن مراسلة حساب إداري من هنا', 403);

    let actionUrl: string;
    let actionText = 'فتح لوحتي';
    let category: NotificationCategory = NotificationCategory.ALL;
    const ctx = input.context;
    if (ctx?.type === 'REQUEST') {
      const req = await prisma.clientRequest.findFirst({ where: { id: ctx.id, clientProfile: { userId: id } }, select: { id: true } });
      if (!req) throw new AppError('هذا الطلب لا يخص المستخدم المحدد', 409);
      actionUrl = CLIENT_ROUTES.request(req.id); actionText = 'عرض الطلب'; category = NotificationCategory.PROJECTS;
    } else if (ctx?.type === 'OFFER') {
      const offer = await prisma.projectProposal.findFirst({ where: { id: ctx.id, providerId: id }, select: { id: true } });
      if (!offer) throw new AppError('هذا العرض لا يخص المستخدم المحدد', 409);
      actionUrl = PROVIDER_ROUTES.offers; actionText = 'عرض عروضي'; category = NotificationCategory.OFFERS;
    } else {
      actionUrl = target.activeRole === UserRole.PROVIDER ? '/provider-overview' : target.activeRole === UserRole.AFFILIATE ? '/marketer-overview' : '/client-overview';
    }

    await prisma.accountAuditLog.create({ data: adminAuditData({
      actor, userId: id, eventType: 'ADMIN_MESSAGE_SENT', title: 'رسالة من الإدارة', summary: `أرسلت الإدارة رسالة للمستخدم: ${message.slice(0, 200)}`,
      details: { context: ctx ?? null }
    }) });
    await notificationService.createAndEmit({ userId: id, title, message, category, type: 'ADMIN_MESSAGE', actionUrl, actionText, metadata: { adminId: actor.id, ...(ctx ? { context: ctx } : {}) } });
    return { sent: true, actionUrl };
  }

  /** Real role / account-type counts for the roles page (no invented members, no permission matrix beyond what the code enforces). */
  async getRolesOverview() {
    const [roleCounts, typeGroups, suspended] = await Promise.all([
      Promise.all(ALL_ROLES.map(async role => ({ role, members: await prisma.user.count({ where: { roles: { has: role } } }) }))),
      prisma.user.groupBy({ by: ['accountType'], _count: { _all: true } }),
      prisma.user.count({ where: { status: { in: [UserStatus.SUSPENDED, UserStatus.SUSPENDED_REVIEW] } } })
    ]);
    return {
      roles: roleCounts.map(r => ({ ...r, label: ROLE_LABELS[r.role], description: ROLE_DESCRIPTIONS[r.role] })),
      accountTypes: typeGroups.map(g => ({ accountType: g.accountType, count: g._count._all })),
      suspendedAccounts: suspended,
      // What the code really enforces for the two admin tiers (see routes/admin-*.routes.ts and the delete-user route).
      adminCapabilities: ADMIN_CAPABILITIES
    };
  }

  /**
   * The provider level ladder (names / thresholds / commission from config/levels.config.ts — the owner-approved table, read-only here) with the real
   * number of providers at each level (ProviderGamification.currentLevelIndex) and the top providers by points. Nothing is simulated.
   */
  async getProviderLevels() {
    const [groups, top, totalProviders] = await Promise.all([
      prisma.providerGamification.groupBy({ by: ['currentLevelIndex'], _count: { _all: true } }),
      prisma.providerGamification.findMany({
        orderBy: [{ points: 'desc' }, { completedProjects: 'desc' }], take: 5,
        select: { points: true, completedProjects: true, avgRating: true, currentLevelIndex: true, provider: { select: { id: true, firstName: true, lastName: true, email: true, totalGmvAmount: true, createdAt: true, providerProfile: { select: { headline: true } } } } }
      }),
      prisma.providerProfile.count()
    ]);
    const countBy = new Map<number, number>(groups.map(g => [g.currentLevelIndex, g._count._all]));
    const tracked = groups.reduce((sum, g) => sum + g._count._all, 0);
    return {
      levels: PROVIDER_LEVELS.map(l => ({ level: l.level, name: l.name, commissionPercent: l.percent, color: levelColor('PROVIDER', l.level), thresholds: { points: l.minPoints, projects: l.minProjects, rating: l.minRating }, providers: countBy.get(l.level) ?? 0 })),
      totalProviders,
      providersWithoutLevelRow: Math.max(0, totalProviders - tracked),
      topProviders: top.map((t: any) => ({
        userId: t.provider?.id, name: `${t.provider?.firstName ?? ''} ${t.provider?.lastName ?? ''}`.trim() || t.provider?.email, specialty: t.provider?.providerProfile?.headline ?? null,
        level: t.currentLevelIndex, levelName: PROVIDER_LEVELS[Math.min(15, Math.max(1, t.currentLevelIndex)) - 1].name, points: t.points, rating: t.avgRating, completedProjects: t.completedProjects,
        revenue: Number(t.provider?.totalGmvAmount ?? 0), memberSince: t.provider?.createdAt ?? null
      }))
    };
  }

  /** One user's file for the admin: identity, roles, KYC, counters and the last records of every tab, all from the database. */
  async getUserDetail(id: string) {
    const user: any = await prisma.user.findUnique({
      where: { id },
      select: {
        id: true, accountType: true, status: true, roles: true, activeRole: true, firstName: true, lastName: true, accountHolderName: true, email: true,
        phoneNumber: true, city: true, idNumber: true, lastActiveAt: true, createdAt: true, totalGmvAmount: true, completedProjectsCount: true,
        ratingAverage: true, tierLevel: true, walletBalance: true,
        clientProfile: { select: { id: true, kycStatus: true, companyName: true } },
        providerProfile: { select: { id: true, kycStatus: true, isVerified: true, headline: true } },
        affiliateProfile: { select: { currentLevel: true, identityVerified: true } }
      }
    });
    if (!user) throw new AppError('المستخدم غير موجود', 404);

    const sessionAgg = prisma.userSession.findFirst({ where: { userId: id }, orderBy: { lastActiveAt: 'desc' }, select: { device: true, lastActiveAt: true } });
    const [requests, orders, disputes, tickets, contracts, payments, audit, lastSession, releasedEscrows, onboarding] = await Promise.all([
      user.clientProfile ? prisma.clientRequest.findMany({ where: { clientProfileId: user.clientProfile.id }, orderBy: { createdAt: 'desc' }, take: 20, select: { id: true, title: true, status: true, proposalsCount: true, createdAt: true } }) : Promise.resolve([]),
      prisma.order.findMany({ where: { userId: id }, orderBy: { createdAt: 'desc' }, take: 20, select: { id: true, orderNumber: true, total: true, status: true, createdAt: true } }),
      prisma.dispute.findMany({ where: { OR: [{ openedById: id }, { againstUserId: id }] }, orderBy: { createdAt: 'desc' }, take: 20, select: { id: true, reason: true, status: true, openedById: true, createdAt: true } }),
      prisma.supportTicket.findMany({ where: { userId: id }, orderBy: { createdAt: 'desc' }, take: 20, select: { id: true, ticketNumber: true, subject: true, status: true, createdAt: true } }),
      prisma.contract.findMany({ where: { OR: [{ clientId: id }, { providerId: id }] }, orderBy: { createdAt: 'desc' }, take: 20, select: { id: true, projectId: true, status: true, price: true, clientId: true, createdAt: true } }),
      prisma.walletTransaction.findMany({ where: { userId: id }, orderBy: { createdAt: 'desc' }, take: 20, select: { id: true, type: true, amount: true, currency: true, status: true, createdAt: true } }),
      prisma.accountAuditLog.findMany({ where: { userId: id }, orderBy: { occurredAt: 'desc' }, take: 15, select: { id: true, eventType: true, title: true, summary: true, source: true, severity: true, occurredAt: true } }),
      sessionAgg,
      user.providerProfile ? prisma.escrow.findMany({ where: { project: { providerId: id }, releasedAmount: { gt: 0 }, updatedAt: { gte: new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth() - 5, 1)) } }, select: { providerNetReleasedAmount: true, releasedAmount: true, feePolicyVersion: true, updatedAt: true } }) : Promise.resolve([]),
      prisma.clientOnboarding.findUnique({ where: { userId: id }, select: { status: true } })
    ]);

    const name = user.accountHolderName || `${user.firstName} ${user.lastName}`.trim() || user.email;
    const typeMeta = getTypeMeta(user.accountType);

    const now = new Date();
    const months = Array.from({ length: 6 }, (_, i) => { const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 5 + i, 1)); return { key: d.toISOString().slice(0, 7), label: d.toISOString().slice(0, 7), value: 0 }; });
    for (const e of releasedEscrows as any[]) {
      const row = months.find(m => m.key === new Date(e.updatedAt).toISOString().slice(0, 7));
      if (row) row.value = Math.round((row.value + Number(e.feePolicyVersion ? e.providerNetReleasedAmount : e.releasedAmount)) * 100) / 100;
    }
    const revenueHistory = months.map(({ label, value }) => ({ label, value })).filter(() => user.providerProfile).filter(m => (releasedEscrows as any[]).length > 0 || m.value > 0);

    return {
      id: user.id,
      name,
      email: user.email,
      phoneNumber: user.phoneNumber,
      accountType: user.accountType,
      type: typeMeta.tab, typeLabel: typeMeta.label, typeBg: typeMeta.bg, typeColor: typeMeta.color,
      status: user.status.toLowerCase(),
      statusOriginal: user.status,
      roles: user.roles,
      activeRole: user.activeRole,
      av: name.charAt(0).toUpperCase(),
      avBg: AVATAR_GRADIENTS[0],
      rating: user.ratingAverage ? user.ratingAverage.toFixed(1) : null,
      level: user.tierLevel || null,
      createdAt: user.createdAt,
      lastActiveAt: user.lastActiveAt,
      kyc: {
        client: user.clientProfile?.kycStatus ?? null,
        clientOnboarding: onboarding?.status ?? null,
        provider: user.providerProfile?.kycStatus ?? null,
        affiliateIdentityVerified: user.affiliateProfile ? !!user.affiliateProfile.identityVerified : null
      },
      kpis: {
        reports: tickets.length,
        disputes: disputes.length,
        avgRating: user.ratingAverage ? Math.round(user.ratingAverage * 10) / 10 : null,
        totalRevenue: `${Number(user.totalGmvAmount || 0).toLocaleString('en-US')} $`,
        completedProjects: user.completedProjectsCount || 0,
        walletBalance: Number(user.walletBalance || 0)
      },
      revenueHistory,
      personalInfo: {
        fullName: name, email: user.email, phoneNumber: user.phoneNumber ?? undefined, city: user.city ?? undefined,
        device: lastSession?.device ?? undefined,
        nationalIdLast4: user.idNumber ? String(user.idNumber).slice(-4) : undefined,
        nationalIdVerified: user.clientProfile?.kycStatus === 'VERIFIED' || user.providerProfile?.kycStatus === 'VERIFIED',
        registeredAt: user.createdAt?.toISOString?.() ?? String(user.createdAt),
        lastLoginAt: lastSession?.lastActiveAt ? new Date(lastSession.lastActiveAt).toISOString() : undefined
      },
      tabs: {
        requests, purchases: orders, disputes, reports: tickets, contracts: contracts.map(c => ({ ...c, role: c.clientId === id ? 'CLIENT' : 'PROVIDER' })), payments
      },
      audit
    };
  }

  /**
   * Permanent deletion (the users.delete permission, enforced by the route). Safeguards: never your own account, never an admin account. The audit row is
   * written on the ACTOR's own log (the deleted account's logs go with it) and commits with the deletion.
   */
  async deleteUser(id: string, actor?: AdminActor) {
    if (actor && actor.id === id) throw new AppError('لا يمكنك حذف حسابك بنفسك', 403);
    const target = await prisma.user.findUnique({ where: { id }, select: { id: true, accountType: true, status: true } });
    if (!target) throw new AppError('المستخدم غير موجود', 404);
    if (ADMIN_TYPES.includes(target.accountType)) throw new AppError('لا يمكن حذف حساب إداري من هنا', 403);
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

      if (actor) {
        await tx.accountAuditLog.create({ data: adminAuditData({
          actor, userId: actor.id, category: LogCategory.SECURITY_CHANGE, eventType: 'USER_DELETED_BY_ADMIN', title: 'حذف حساب مستخدم نهائياً',
          summary: `حذف المدير العام الحساب ${id} نهائياً`, severity: 'CRITICAL', before: { accountType: target.accountType, status: target.status }, details: { deletedUserId: id }
        }) });
      }

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
      // AI Cleanup Batch 3: "Risk Level" / "Risk Score" columns removed.
      // User.aiRiskLevel / aiRiskScore are never written by any code path —
      // every row carried the schema defaults (LOW / 10), which read as a
      // real risk assessment. No risk engine exists, so no column is emitted.
      'Total GMV (USD)',
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
