import { Request, Response, NextFunction } from 'express';
import { accountManagementService } from '../services/account-management.service';
import { AppError } from '../utils/app-error';
import { logger } from '../config/logger';

export class AccountManagementController {
  public async getAvailableAccountTypes(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const userId = req.user?.userId || req.user?.id;
      if (!userId) throw new AppError('غير مصرح لك بالوصول', 401);

      const result = await accountManagementService.getAvailableAccountTypes(userId);
      res.status(200).json({
        success: true,
        data: result
      });
    } catch (error) {
      next(error);
    }
  }

  public async addAccountType(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const userId = req.user?.userId || req.user?.id;
      if (!userId) throw new AppError('غير مصرح لك بالوصول', 401);

      const { targetRole, profileMetadata } = req.body;
      const result = await accountManagementService.addAccountType(userId, targetRole, profileMetadata, { sessionId: req.user?.sessionId, ipAddress: req.ip, device: req.get('user-agent')?.slice(0, 120) });

      res.cookie('waseet_token', result.token, {
        maxAge: 7 * 24 * 60 * 60 * 1000,
        httpOnly: true,
        secure: process.env.NODE_ENV === 'production',
        sameSite: 'lax',
        path: '/'
      });

      res.status(201).json({
        success: true,
        message: 'تم إضافة نوع الحساب بنجاح',
        data: result
      });
    } catch (error) {
      // Anything that is not an AppError (e.g. a Prisma/DB failure) used to surface as the English
      // "Internal Server Error". Keep the details in the log, give the user an Arabic message.
      if (!(error instanceof AppError)) {
        logger.error('addAccountType failed:', error);
        return next(new AppError('تعذر إرسال طلب إضافة الحساب. حاول مرة أخرى أو تواصل مع الدعم.', 500));
      }
      next(error);
    }
  }

  public async switchActiveRole(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const userId = req.user?.userId || req.user?.id;
      if (!userId) throw new AppError('غير مصرح لك بالوصول', 401);

      const { targetRole } = req.body;
      const result = await accountManagementService.switchActiveRole(userId, targetRole, { sessionId: req.user?.sessionId, ipAddress: req.ip, device: req.get('user-agent')?.slice(0, 120) });

      res.cookie('waseet_token', result.token, {
        maxAge: 7 * 24 * 60 * 60 * 1000,
        httpOnly: true,
        secure: process.env.NODE_ENV === 'production',
        sameSite: 'lax',
        path: '/'
      });

      res.status(200).json({
        success: true,
        message: `تم الانتقال إلى حساب ${targetRole} بنجاح`,
        data: result
      });
    } catch (error) {
      next(error);
    }
  }
}

export const accountManagementController = new AccountManagementController();
