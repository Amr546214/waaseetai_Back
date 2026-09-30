import { Request, Response, NextFunction } from 'express';
import { affiliatesPublicService } from '../services/affiliates-public.service';
import { AppError } from '../utils/app-error';

export class AffiliatesPublicController {
  public async resolve(req: Request, res: Response, next: NextFunction) {
    try {
      const code = typeof req.query.code === 'string' ? req.query.code : '';
      if (!code.trim()) {
        throw new AppError('كود الإحالة مطلوب', 400);
      }

      const affiliate = await affiliatesPublicService.resolveByCode(code);
      if (!affiliate) {
        throw new AppError('لم يتم العثور على وسيط بهذا الكود', 404);
      }

      res.status(200).json({ success: true, data: affiliate });
    } catch (error) {
      next(error);
    }
  }

  public async search(req: Request, res: Response, next: NextFunction) {
    try {
      const query = typeof req.query.q === 'string' ? req.query.q : '';
      const results = await affiliatesPublicService.search(query);

      res.status(200).json({ success: true, data: results });
    } catch (error) {
      next(error);
    }
  }
}

export const affiliatesPublicController = new AffiliatesPublicController();
