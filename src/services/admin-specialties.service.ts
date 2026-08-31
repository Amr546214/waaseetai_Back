import { prisma } from '../config/db';
import { AppError } from '../utils/app-error';

export class AdminSpecialtiesService {
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
    const startOfMonth = new Date();
    startOfMonth.setDate(1);
    startOfMonth.setHours(0, 0, 0, 0);

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
    return prisma.category.create({ data });
  }

  async updateCategory(id: string, data: any) {
    return prisma.category.update({ where: { id }, data });
  }

  async toggleCategoryStatus(id: string) {
    const category = await prisma.category.findUnique({ where: { id } });
    if (!category) throw new AppError('Category not found', 404);

    return prisma.category.update({
      where: { id },
      data: { isActive: !category.isActive }
    });
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

    return prisma.category.delete({ where: { id } });
  }

  async createSpecialty(data: { slug: string; categoryId: string; nameAr: string; nameEn?: string; description?: string }) {
    return prisma.specialty.create({ data });
  }

  async updateSpecialty(id: string, data: any) {
    return prisma.specialty.update({ where: { id }, data });
  }

  async toggleSpecialtyStatus(id: string) {
    const specialty = await prisma.specialty.findUnique({ where: { id } });
    if (!specialty) throw new AppError('Specialty not found', 404);

    return prisma.specialty.update({
      where: { id },
      data: { isActive: !specialty.isActive }
    });
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

    return prisma.specialty.delete({ where: { id } });
  }

}
