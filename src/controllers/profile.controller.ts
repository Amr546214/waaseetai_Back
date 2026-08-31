import { Request, Response, NextFunction } from 'express';
import { profileService } from '../services/profile.service';
import { AppError } from '../utils/app-error';
import { updateProfileSchema } from '../dtos/profile.dto';

export class ProfileController {
  
  public async getProfile(req: Request, res: Response, next: NextFunction) {
    try {
      if (!req.user) {
        throw new AppError('غير مصرح لك بالوصول', 401);
      }

      const profile = await profileService.getProfile(req.user.userId);

      res.status(200).json({
        success: true,
        data: profile
      });
    } catch (error) {
      next(error);
    }
  }

  public async updateProfile(req: Request, res: Response, next: NextFunction) {
    try {
      if (!req.user) {
        throw new AppError('غير مصرح لك بالوصول', 401);
      }

      const validatedData = updateProfileSchema.parse(req.body);
      const result = await profileService.updateProfile(req.user.userId, req.user.accountType, validatedData);

      res.status(200).json({
        success: true,
        message: 'تم تحديث الملف الشخصي بنجاح',
        data: result
      });
    } catch (error) {
      next(error);
    }
  }

  public async updateTab(req: Request, res: Response, next: NextFunction) {
    try {
      if (!req.user) {
        throw new AppError('غير مصرح لك بالوصول', 401);
      }

      const tabName = req.params.tabName as string;
      const result = await profileService.updateTab(req.user.userId, tabName, req.body);

      res.status(200).json({
        success: true,
        message: result.message,
        data: result
      });
    } catch (error) {
      next(error);
    }
  }

  public async getMyChangeRequests(req: Request, res: Response, next: NextFunction) {
    try {
      if (!req.user) {
        throw new AppError('غير مصرح لك بالوصول', 401);
      }

      const result = await profileService.getMyChangeRequests(req.user.userId);

      res.status(200).json({
        success: true,
        data: result
      });
    } catch (error) {
      next(error);
    }
  }
}

export const profileController = new ProfileController();
