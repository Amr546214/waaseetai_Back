import { Request, Response, NextFunction } from 'express';
import { profileService } from '../services/profile.service';
import { AppError } from '../utils/app-error';
import { updateProfileSchema } from '../dtos/profile.dto';
import { profileTabSchemas } from '../dtos/profile-tab.dto';

/**
 * Phase 3D.1 final review: activeRole is guaranteed by auth.middleware.ts —
 * User.activeRole is a NOT NULL DB column with a schema default, always
 * selected and assigned onto req.user on every authenticated request. If it
 * is ever missing despite that guarantee (a bug, or some future auth path
 * that doesn't go through the normal middleware), fail safely instead of
 * silently guessing CLIENT as the write target — an ambiguous display-field
 * write target must never be defaulted.
 *
 * A plain function, not a class method: ProfileController's methods are
 * registered as detached references in profile.routes.ts
 * (`profileController.updateProfile`, no `.bind`), so a `this.something()`
 * helper would find `this` undefined at call time and throw.
 */
function requireActiveRole(req: Request) {
  const activeRole = req.user?.activeRole;
  if (!activeRole) {
    throw new AppError('تعذر تحديد الدور النشط لحسابك، يرجى إعادة تسجيل الدخول', 401);
  }
  return activeRole;
}

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

      // Phase 3D.1: target role is the caller's CURRENTLY ACTIVE role, not
      // their original signup accountType.
      const activeRole = requireActiveRole(req);
      // safeParse: a ZodError here is a client mistake (400), not a server fault (500).
      const parsed = updateProfileSchema.safeParse(req.body);
      if (!parsed.success) {
        const errors = parsed.error.issues.map((issue) => {
          const field = issue.path.join('.');
          return { path: field, field, message: issue.message, code: issue.code };
        });
        return void res.status(400).json({
          success: false,
          message: 'بيانات الملف الشخصي غير صحيحة، يرجى مراجعة الحقول المحددة',
          errors,
        });
      }
      const validatedData = parsed.data;
      const result = await profileService.updateProfile(req.user.userId, activeRole, validatedData);

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
      const activeRole = requireActiveRole(req);
      // Validate against the tab's schema (types + length limits); unknown keys are stripped. An unknown tab still reaches the service's 400.
      const schema = (profileTabSchemas as Record<string, (typeof profileTabSchemas)[keyof typeof profileTabSchemas]>)[tabName];
      let body: unknown = req.body;
      if (schema) {
        const parsed = schema.safeParse(req.body ?? {});
        if (!parsed.success) {
          const errors = parsed.error.issues.map((issue) => {
            const field = issue.path.join('.');
            return { path: field, field, message: issue.message, code: issue.code };
          });
          return void res.status(400).json({ success: false, message: 'بيانات غير صحيحة، يرجى مراجعة الحقول المحددة', errors });
        }
        body = parsed.data;
      }
      const result = await profileService.updateTab(req.user.userId, tabName, body, activeRole);

      res.status(200).json({
        success: true,
        message: result.message,
        data: result
      });
    } catch (error) {
      next(error);
    }
  }

  public async cancelMyChangeRequest(req: Request, res: Response, next: NextFunction) {
    try {
      if (!req.user) {
        throw new AppError('غير مصرح لك بالوصول', 401);
      }
      const result = await profileService.cancelMyChangeRequest(req.user.userId, String(req.params.id));
      res.status(200).json({ success: true, message: 'تم سحب الطلب', data: result });
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
