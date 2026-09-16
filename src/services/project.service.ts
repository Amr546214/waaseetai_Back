import { prisma } from '../config/db';
import { CreateProjectDto } from '../dtos/project.dto';
import { AccountType, ProjectStatus, SpecialtyVerificationStatus, UserRole } from '@prisma/client';
import { AppError } from '../utils/app-error';
import { ensureCloudinaryUrl } from '../utils/cloudinary-storage';

interface ProjectSummaryActor {
  userId: string;
  accountType?: AccountType;
  activeRole?: UserRole;
  roles?: UserRole[];
}

export class ProjectService {
  /**
   * Create a new project for a client
   */
  public async createProject(clientId: string, data: CreateProjectDto) {
    try {
	  const attachments = (await Promise.all((data.attachments || []).map((url, index) =>
		ensureCloudinaryUrl(url, `waseetai/clients/${clientId}/projects`, `attachment-${index + 1}`)
	  ))).filter((url): url is string => Boolean(url));
      const project = await prisma.project.create({
        data: {
          clientId,
          title: data.title,
          description: data.description,
          specialty: data.specialty,
          subSpecialties: data.subSpecialties,
          ndaType: data.ndaType,
          ipRights: data.ipRights,
          provLevel: data.provLevel,
          provRating: data.provRating,
          provLang: data.provLang,
          provLocation: data.provLocation,
          customConditions: data.customConditions,
          requirements: data.requirements,
          outputs: data.outputs,
          deliveryDays: data.deliveryDays,
          budgetType: data.budgetType,
          budgetMin: data.budgetMin,
          budgetMax: data.budgetMax,
          budgetFixed: data.budgetFixed,
          budgetHourly: data.budgetHourly,
          allowNegotiation: data.allowNegotiation,
          splitMilestones: data.splitMilestones,
          milestones: data.milestones ? data.milestones : undefined,
          attachments,
          status: ProjectStatus.OPEN
        }
      });
      
      // Update User points (Gamification logic placeholder)
      // e.g. await prisma.user.update(...)

      return project;
    } catch (error) {
      console.error('[ProjectService.createProject] Error:', error);
      throw new AppError('فشل في إنشاء المشروع، يرجى المحاولة مرة أخرى', 500);
    }
  }
  /**
   * Get all projects for the logged-in client with dynamic status counters
   */
  public async getMyRequests(clientId: string) {
    try {
      // 1. Parallel transaction to fetch projects and grouped counts
      const [projects, counts] = await prisma.$transaction([
        // Fetch projects with proposal counts
        prisma.project.findMany({
          where: { clientId },
          orderBy: { createdAt: 'desc' },
          include: {
            _count: {
              select: { proposals: true, projectProposals: true }
            }
          }
        }),
        // Fetch grouped counts by status
        prisma.project.groupBy({
          by: ['status'],
          where: { clientId },
          orderBy: { status: 'asc' },
          _count: {
            status: true
          }
        })
      ]);

      // 2. Aggregate counts into requested categories
      let allCount = 0, activeCount = 0, pendingCount = 0, closedCount = 0, draftCount = 0;
      
      counts.forEach((group) => {
        const count = group._count.status;
        allCount += count;
        
        switch (group.status) {
          case ProjectStatus.OPEN:
          case ProjectStatus.IN_PROGRESS:
            activeCount += count;
            break;
          case ProjectStatus.PENDING_REVIEW:
          case ProjectStatus.AWAITING_DELIVERY:
            pendingCount += count;
            break;
          case ProjectStatus.COMPLETED:
            closedCount += count;
            break;
          case ProjectStatus.DRAFT:
            draftCount += count;
            break;
        }
      });

      return {
        filters: {
          allCount,
          activeCount,
          pendingCount,
          closedCount,
          draftCount
        },
        data: projects.map((p: any) => ({
          ...p,
          proposalsCount: p.proposalsCount || ((p._count?.proposals || 0) + (p._count?.projectProposals || 0))
        }))
      };
    } catch (error) {
      console.error('[ProjectService.getMyRequests] Error:', error);
      throw new AppError('فشل في جلب الطلبات، يرجى المحاولة مرة أخرى', 500);
    }
  }

  private createProjectAccessError(): AppError {
    return new AppError('المشروع غير موجود أو لا تملك صلاحية الوصول إليه', 404);
  }

  private normalizeSpecialty(value: unknown): string | null {
    if (typeof value !== 'string') return null;

    const normalized = value.trim().toLowerCase();
    return normalized.length > 0 ? normalized : null;
  }

  private isProviderLikeActor(actor: ProjectSummaryActor): boolean {
    if (
      actor.accountType === AccountType.PROVIDER_COMPANY ||
      actor.accountType === AccountType.PROVIDER_INDIVIDUAL ||
      actor.accountType === AccountType.MARKETING_BROKER
    ) {
      return true;
    }

    const roles = new Set<UserRole>(actor.roles || []);
    if (actor.activeRole) roles.add(actor.activeRole);

    return roles.has(UserRole.PROVIDER) || roles.has(UserRole.AFFILIATE);
  }

  private async providerCanSeeOpenProject(
    providerId: string,
    projectSpecialty: string | null
  ): Promise<boolean> {
    const normalizedProjectSpecialty = this.normalizeSpecialty(projectSpecialty);
    if (!normalizedProjectSpecialty) return false;

    const providerProfile = await prisma.providerProfile.findUnique({
      where: { userId: providerId },
      include: {
        providerSpecialties: {
          where: {
            isActive: true,
            status: SpecialtyVerificationStatus.APPROVED,
          },
          include: { specialty: true },
        },
      },
    });

    const providerSpecialties = providerProfile?.providerSpecialties || [];
    const providerSpecialtyIds = providerSpecialties
      .map(providerSpecialty => providerSpecialty.specialtyId)
      .filter(Boolean);

    if (providerSpecialtyIds.length === 0) return false;

    const providerKeywords = new Set(
      providerSpecialties
        .flatMap(providerSpecialty => [
          providerSpecialty.specialty?.nameAr,
          providerSpecialty.specialty?.name,
          providerSpecialty.specialty?.nameEn,
          ...(providerSpecialty.subSpecialties || []),
        ])
        .map(value => this.normalizeSpecialty(value))
        .filter((value): value is string => Boolean(value))
    );

    return providerKeywords.has(normalizedProjectSpecialty);
  }

  private async assertCanAccessProjectSummary(
    projectId: string,
    actor: ProjectSummaryActor
  ): Promise<void> {
    const project = await prisma.project.findUnique({
      where: { id: projectId },
      select: {
        id: true,
        status: true,
        specialty: true,
        clientId: true,
        providerId: true,
        contract: {
          select: {
            clientId: true,
            providerId: true,
          },
        },
        projectProposals: {
          where: { providerId: actor.userId },
          select: { id: true },
          take: 1,
        },
        proposals: {
          where: { providerId: actor.userId },
          select: { id: true },
          take: 1,
        },
      },
    });

    if (!project) {
      throw this.createProjectAccessError();
    }

    if (project.clientId === actor.userId) return;
    if (project.providerId === actor.userId) return;
    if (
      project.contract?.clientId === actor.userId ||
      project.contract?.providerId === actor.userId
    ) return;
    if (project.projectProposals.length > 0 || project.proposals.length > 0) return;

    if (
      project.status === ProjectStatus.OPEN &&
      this.isProviderLikeActor(actor) &&
      await this.providerCanSeeOpenProject(actor.userId, project.specialty)
    ) {
      return;
    }

    throw this.createProjectAccessError();
  }

  /**
   * Fetch summarized project parameters required for rendering the proposal application wizard summary bar
   */
  public async getProjectSummary(projectId: string, actor: ProjectSummaryActor) {
    try {
      await this.assertCanAccessProjectSummary(projectId, actor);

      const project = await prisma.project.findUnique({
        where: { id: projectId },
        select: {
          id: true,
          title: true,
          description: true,
          specialty: true,
          subSpecialties: true,
          requirements: true,
          outputs: true,
          customConditions: true,
          deliveryDays: true,
          budgetType: true,
          budgetMin: true,
          budgetMax: true,
          budgetFixed: true,
          budgetHourly: true,
          status: true,
          createdAt: true,
          _count: {
            select: {
              proposals: true,
              projectProposals: true
            }
          },
          client: {
            select: {
              id: true,
              firstName: true,
              lastName: true,
              avatarUrl: true,
              clientProfile: {
                select: {
                  companyName: true,
                  kycStatus: true
                }
              }
            }
          }
        }
      });

      if (!project) {
        throw this.createProjectAccessError();
      }

      const totalProposalsCount = (project._count?.projectProposals ?? 0) + (project._count?.proposals ?? 0);

      return {
        id: project.id,
        title: project.title,
        description: project.description || 'لا يوجد وصف متاح',
        specialty: project.specialty || 'تصميم جرافيك',
        subSpecialties: project.subSpecialties,
        requirements: (project.requirements && project.requirements.length > 0) ? project.requirements : ['Adobe Illustrator', 'ملفات قابلة للتعديل', '3+ سنوات خبرة'],
        outputs: project.outputs || 'شعار بصيغ متعددة + بطاقات أعمال + قرطاسية + دليل الهوية',
        clientType: project.client.clientProfile?.companyName ? 'شركة' : 'فرد',
        deliveryDays: project.deliveryDays,
        budgetType: project.budgetType,
        budgetMin: project.budgetMin,
        budgetMax: project.budgetMax,
        budgetFixed: project.budgetFixed,
        budgetHourly: project.budgetHourly,
        status: project.status,
        createdAt: project.createdAt,
        proposalsCount: totalProposalsCount,
        client: {
          id: project.client.id,
          name: project.client.clientProfile?.companyName || `${project.client.firstName} ${project.client.lastName}`,
          avatarUrl: project.client.avatarUrl,
          isVerified: project.client.clientProfile?.kycStatus === 'VERIFIED'
        }
      };
    } catch (error) {
      if (error instanceof AppError) throw error;
      console.error('[ProjectService.getProjectSummary] Error:', error);
      throw new AppError('فشل في استعراض بيانات ملخص المشروع', 500);
    }
  }
}

export const projectService = new ProjectService();
