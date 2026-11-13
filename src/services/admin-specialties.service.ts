import { markSettingsChanged } from './settings-revision';
import type { Prisma } from '@prisma/client';
import { prisma } from '../config/db';
import { platformZone, startOfMonthInZone } from '../utils/platform-time';
import { AppError } from '../utils/app-error';

export class AdminSpecialtiesService {
  private async mutate<T>(fn: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
    const result = await prisma.$transaction(async tx => {
      const result = await fn(tx);
      await markSettingsChanged(tx, ['taxonomy']);
      return result;
    });
    return result;
  }
  async getStats() {
    const totalSpecialties = await prisma.specialty.count();
    const totalCategories = await prisma.category.count();
    const activeSpecialtiesCount = await prisma.specialty.count({ where: { isActive: true } });
    
    // Total providers with at least one approved specialty
    let activeProvidersCount = 0;
    try {
      const groups = await prisma.providerSpecialty.groupBy({
        by: ['providerProfileId'],
        where: { isPassed: true, isActive: true },
      });
      activeProvidersCount = groups.length;
    } catch (error) {
      console.warn("Could not query providerSpecialty groups", error);
    }

    // Total AccreditationSubmission records created this month
    const zone = await platformZone();
    const startOfMonth = zone ? startOfMonthInZone(zone) : new Date();
    if (!zone) { startOfMonth.setDate(1); startOfMonth.setHours(0, 0, 0, 0); }

    let monthlyAccreditationRequests = 0;
    try {
      monthlyAccreditationRequests = await prisma.accreditationSubmission.count({
        where: {
          createdAt: { gte: startOfMonth }
        }
      });
    } catch (error) {
      console.warn("Could not query accreditationSubmissions", error);
    }

    return {
      totalSpecialties,
      totalCategories,
      activeSpecialtiesCount,
      activeProvidersCount,
      monthlyAccreditationRequests,
    };
  }

  async getTree(search: string = '') {
    const categories = await prisma.category.findMany({
      orderBy: { sortOrder: 'asc' },
      include: {
        specialties: {
          where: search ? {
            OR: [
              { nameAr: { contains: search, mode: 'insensitive' } },
              { nameEn: { contains: search, mode: 'insensitive' } }
            ]
          } : undefined,
          orderBy: { sortOrder: 'asc' },
          include: {
            _count: {
              select: { providerSpecialties: true, accreditationSubmissions: true }
            }
          }
        }
      }
    });

    return categories.map(cat => ({
      ...cat,
      specialties: cat.specialties.map(spec => ({
        ...spec,
        providersCount: spec._count?.providerSpecialties || 0,
        monthlyRequests: spec._count?.accreditationSubmissions || 0,
      }))
    }));
  }

  async createCategory(data: { slug: string; nameAr: string; nameEn?: string; description?: string }) {
    return this.mutate(tx => tx.category.create({ data: { ...data, name: data.nameAr } }));
  }

  async updateCategory(id: string, data: any) {
    return this.mutate(async tx => {
      const old = await tx.category.findUniqueOrThrow({ where: { id } });
      const updated = await tx.category.update({ where: { id }, data: { ...data, ...(data.nameAr !== undefined ? { name: data.nameAr } : {}) } });
      // Current profile labels/slugs are legacy references; stable FK relations already read the new title.
      // Project/contract snapshots retain the text agreed at creation.
      if (old.slug !== updated.slug || old.nameAr !== updated.nameAr) {
        await tx.project.updateMany({ where: { specialty: { in: [old.slug, old.nameAr, old.name].filter(Boolean) as string[] } }, data: { specialty: updated.slug } });
        await tx.providerProfile.updateMany({ where: { mainSpecialty: { in: [old.slug, old.nameAr, old.name].filter(Boolean) as string[] } }, data: { mainSpecialty: updated.slug } });
      }
      return updated;
    });
  }

  async toggleCategoryStatus(id: string) {
    const category = await prisma.category.findUnique({ where: { id } });
    if (!category) throw new AppError('Category not found', 404);

    return this.mutate(tx => tx.category.update({ where: { id }, data: { isActive: !category.isActive } }));
  }

  async deleteCategory(id: string) {
    const category = await prisma.category.findUnique({
      where: { id },
      include: { _count: { select: { specialties: true } } }
    });

    if (!category) throw new AppError('Category not found', 404);

    if (category._count && category._count.specialties > 0) {
      throw new AppError('لا يمكن حذف قسم يحتوي على تخصصات. يرجى حذف التخصصات أو نقلها أولاً.', 400);
    }

    return this.mutate(tx => tx.category.delete({ where: { id } }));
  }

  async createSpecialty(data: { slug: string; categoryId: string; nameAr: string; nameEn?: string; description?: string }) {
    return this.mutate(tx => tx.specialty.create({ data: { ...data, name: data.nameAr } }));
  }

  async updateSpecialty(id: string, data: any) {
    return this.mutate(async tx => {
      const old = await tx.specialty.findUniqueOrThrow({ where: { id } });
      const updated = await tx.specialty.update({ where: { id }, data: { ...data, ...(data.nameAr !== undefined ? { name: data.nameAr } : {}) } });
      if (old.nameAr !== updated.nameAr) {
        await tx.$executeRaw`UPDATE projects SET "subSpecialties" = array_replace("subSpecialties", ${old.nameAr}, ${updated.nameAr}) WHERE "subSpecialties" @> ARRAY[${old.nameAr}]::text[]`;
        await tx.$executeRaw`UPDATE provider_profiles SET "subSpecialties" = array_replace("subSpecialties", ${old.nameAr}, ${updated.nameAr}) WHERE "subSpecialties" @> ARRAY[${old.nameAr}]::text[]`;
      }
      return updated;
    });
  }

  async toggleSpecialtyStatus(id: string) {
    const specialty = await prisma.specialty.findUnique({ where: { id } });
    if (!specialty) throw new AppError('Specialty not found', 404);

    return this.mutate(tx => tx.specialty.update({ where: { id }, data: { isActive: !specialty.isActive } }));
  }

  async deleteSpecialty(id: string) {
    const specialty = await prisma.specialty.findUnique({
      where: { id },
      include: { _count: { select: { providerSpecialties: true } } }
    });

    if (!specialty) throw new AppError('Specialty not found', 404);

    if (specialty._count && specialty._count.providerSpecialties > 0) {
      throw new AppError('لا يمكن حذف تخصص مرتبط بمقدمي خدمة نشطين.', 400);
    }

    return this.mutate(tx => tx.specialty.delete({ where: { id } }));
  }

}
