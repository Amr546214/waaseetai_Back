import { Request, Response, NextFunction } from 'express';
import { AdminSpecialtiesService } from '../services/admin-specialties.service';
import { recordAdminAudit } from '../utils/admin-audit';
import { fieldError, fieldErrors } from '../utils/app-error';

const specialtiesService = new AdminSpecialtiesService();

// Only these fields can be written by an admin (no mass-assignment of id/createdAt/relations).
const CATEGORY_FIELDS = ['slug', 'nameAr', 'nameEn', 'icon', 'description', 'sortOrder', 'isActive'] as const;
function pickCategory(body: any, partial: boolean) {
  const out: Record<string, unknown> = {};
  for (const k of CATEGORY_FIELDS) if (body && body[k] !== undefined) out[k] = body[k];
  if (!partial && (!out.slug || !out.nameAr)) throw fieldErrors('المعرّف والاسم العربي مطلوبان', [...(!out.nameAr ? [{ field: 'nameAr', message: 'الاسم العربي مطلوب' }] : []), ...(!out.slug ? [{ field: 'slug', message: 'المعرّف (slug) مطلوب' }] : [])]);
  for (const k of ['slug', 'nameAr', 'nameEn', 'icon', 'description']) if (out[k] !== undefined && typeof out[k] !== 'string') throw fieldError(k, 'قيمة غير صالحة');
  if (out.sortOrder !== undefined && !Number.isInteger(out.sortOrder)) throw fieldError('sortOrder', 'ترتيب غير صالح');
  if (out.isActive !== undefined && typeof out.isActive !== 'boolean') throw fieldError('isActive', 'قيمة غير صالحة');
  return out;
}
const brief = (c: any) => c && ({ id: c.id, slug: c.slug, nameAr: c.nameAr, nameEn: c.nameEn, isActive: c.isActive, sortOrder: c.sortOrder });

export class AdminSpecialtiesController {
  
  static async getStats(req: Request, res: Response, next: NextFunction) {
    try {
      const stats = await specialtiesService.getStats();
      res.status(200).json({ success: true, data: stats });
    } catch (error) {
      next(error);
    }
  }

  static async getTree(req: Request, res: Response, next: NextFunction) {
    try {
      const search = req.query.search as string;
      const tree = await specialtiesService.getTree(search);
      res.status(200).json({ success: true, data: tree });
    } catch (error) {
      next(error);
    }
  }

  static async createCategory(req: Request, res: Response, next: NextFunction) {
    try {
      const category = await specialtiesService.createCategory(pickCategory(req.body, false) as any);
      await recordAdminAudit(req, { eventType: 'CATEGORY_CREATED', title: 'إضافة قسم', summary: `إضافة قسم: ${category.nameAr}`, after: brief(category) });
      res.status(201).json({ success: true, data: category });
    } catch (error) {
      next(error);
    }
  }

  static async updateCategory(req: Request, res: Response, next: NextFunction) {
    try {
      const category = await specialtiesService.updateCategory(String(req.params.id), pickCategory(req.body, true));
      await recordAdminAudit(req, { eventType: 'CATEGORY_UPDATED', title: 'تعديل قسم', summary: `تعديل قسم: ${category.nameAr}`, after: brief(category) });
      res.status(200).json({ success: true, data: category });
    } catch (error) {
      next(error);
    }
  }

  static async toggleCategoryStatus(req: Request, res: Response, next: NextFunction) {
    try {
      const category = await specialtiesService.toggleCategoryStatus(String(req.params.id));
      await recordAdminAudit(req, { eventType: category.isActive ? 'CATEGORY_ENABLED' : 'CATEGORY_DISABLED', title: category.isActive ? 'تفعيل قسم' : 'تعطيل قسم', summary: `${category.isActive ? 'تفعيل' : 'تعطيل'} قسم: ${category.nameAr}`, after: brief(category) });
      res.status(200).json({ success: true, data: category });
    } catch (error) {
      next(error);
    }
  }

  static async deleteCategory(req: Request, res: Response, next: NextFunction) {
    try {
      await specialtiesService.deleteCategory(String(req.params.id));
      await recordAdminAudit(req, { eventType: 'CATEGORY_DELETED', title: 'حذف قسم', summary: 'حذف قسم فارغ', severity: 'WARNING', details: { categoryId: String(req.params.id) } });
      res.status(200).json({ success: true, message: 'Category deleted successfully' });
    } catch (error) {
      next(error);
    }
  }

  static async createSpecialty(req: Request, res: Response, next: NextFunction) {
    try {
      const specialty = await specialtiesService.createSpecialty(req.body);
      await recordAdminAudit(req, { eventType: 'SPECIALTY_CREATED', title: 'إضافة تخصص', summary: `إضافة تخصص: ${specialty.nameAr}`, details: { specialtyId: specialty.id } });
      res.status(201).json({ success: true, data: specialty });
    } catch (error) {
      next(error);
    }
  }

  static async updateSpecialty(req: Request, res: Response, next: NextFunction) {
    try {
      const specialty = await specialtiesService.updateSpecialty(String(req.params.id), req.body);
      await recordAdminAudit(req, { eventType: 'SPECIALTY_UPDATED', title: 'تعديل تخصص', summary: `تعديل تخصص: ${specialty.nameAr}`, details: { specialtyId: specialty.id } });
      res.status(200).json({ success: true, data: specialty });
    } catch (error) {
      next(error);
    }
  }

  static async toggleStatus(req: Request, res: Response, next: NextFunction) {
    try {
      const specialty = await specialtiesService.toggleSpecialtyStatus(String(req.params.id));
      await recordAdminAudit(req, { eventType: specialty.isActive ? 'SPECIALTY_ENABLED' : 'SPECIALTY_DISABLED', title: specialty.isActive ? 'تفعيل تخصص' : 'تعطيل تخصص', summary: `${specialty.isActive ? 'تفعيل' : 'تعطيل'} تخصص: ${specialty.nameAr}`, details: { specialtyId: specialty.id } });
      res.status(200).json({ success: true, data: specialty });
    } catch (error) {
      next(error);
    }
  }

  static async deleteSpecialty(req: Request, res: Response, next: NextFunction) {
    try {
      await specialtiesService.deleteSpecialty(String(req.params.id));
      await recordAdminAudit(req, { eventType: 'SPECIALTY_DELETED', title: 'حذف تخصص', summary: 'حذف تخصص', severity: 'WARNING', details: { specialtyId: String(req.params.id) } });
      res.status(200).json({ success: true, message: 'Specialty deleted successfully' });
    } catch (error) {
      next(error);
    }
  }
}
