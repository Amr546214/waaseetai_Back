import { Request, Response, NextFunction } from 'express';
import { AdminSpecialtiesService } from '../services/admin-specialties.service';

const specialtiesService = new AdminSpecialtiesService();

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
      const category = await specialtiesService.createCategory(req.body);
      res.status(201).json({ success: true, data: category });
    } catch (error) {
      next(error);
    }
  }

  static async updateCategory(req: Request, res: Response, next: NextFunction) {
    try {
      const category = await specialtiesService.updateCategory(String(req.params.id), req.body);
      res.status(200).json({ success: true, data: category });
    } catch (error) {
      next(error);
    }
  }

  static async toggleCategoryStatus(req: Request, res: Response, next: NextFunction) {
    try {
      const category = await specialtiesService.toggleCategoryStatus(String(req.params.id));
      res.status(200).json({ success: true, data: category });
    } catch (error) {
      next(error);
    }
  }

  static async deleteCategory(req: Request, res: Response, next: NextFunction) {
    try {
      await specialtiesService.deleteCategory(String(req.params.id));
      res.status(200).json({ success: true, message: 'Category deleted successfully' });
    } catch (error) {
      next(error);
    }
  }

  static async createSpecialty(req: Request, res: Response, next: NextFunction) {
    try {
      const specialty = await specialtiesService.createSpecialty(req.body);
      res.status(201).json({ success: true, data: specialty });
    } catch (error) {
      next(error);
    }
  }

  static async updateSpecialty(req: Request, res: Response, next: NextFunction) {
    try {
      const specialty = await specialtiesService.updateSpecialty(String(req.params.id), req.body);
      res.status(200).json({ success: true, data: specialty });
    } catch (error) {
      next(error);
    }
  }

  static async toggleStatus(req: Request, res: Response, next: NextFunction) {
    try {
      const specialty = await specialtiesService.toggleSpecialtyStatus(String(req.params.id));
      res.status(200).json({ success: true, data: specialty });
    } catch (error) {
      next(error);
    }
  }

  static async deleteSpecialty(req: Request, res: Response, next: NextFunction) {
    try {
      await specialtiesService.deleteSpecialty(String(req.params.id));
      res.status(200).json({ success: true, message: 'Specialty deleted successfully' });
    } catch (error) {
      next(error);
    }
  }
}
