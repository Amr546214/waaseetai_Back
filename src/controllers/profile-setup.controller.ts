import { Request, Response, NextFunction } from 'express';
import { profileSetupSchema } from '../dtos/profile-setup.dto';
import { profileSetupService } from '../services/profile-setup.service';

export class ProfileSetupController {
  public async setupProfile(req: Request, res: Response, next: NextFunction) {
    try {
      // 1. Validate incoming data
      // safeParse: a bad body is a client mistake (400 with the fields named), never a 500.
      const parsed = profileSetupSchema.safeParse(req.body ?? {});
      if (!parsed.success) {
        const errors = parsed.error.issues.map((issue) => {
          const field = issue.path.join('.');
          return { path: field, field, message: issue.message, code: issue.code };
        });
        return void res.status(400).json({ success: false, message: 'بيانات غير صحيحة، يرجى مراجعة الحقول المحددة', errors });
      }
      const validatedData = parsed.data;

      // 2. Extract user info from authenticated request. Phase 3D.2A: target
      // role resolved from activeRole, not accountType — the service itself
      // rejects any role it doesn't support (see saveProfileSetup), so a
      // missing/falsy activeRole fails safely there too, without needing a
      // separate guard here.
      const userId = req.user!.userId;
      const activeRole = req.user!.activeRole!;

      // 3. Execute setup transaction
      const result = await profileSetupService.saveProfileSetup(userId, activeRole, validatedData);

      // 4. Return robust response
      res.status(200).json({
        success: true,
        message: result.identitySubmitted ? 'تم حفظ بيانات إعداد الملف الشخصي وإرسال وثائق الهوية للمراجعة' : 'تم حفظ بيانات إعداد الملف الشخصي بنجاح',
        data: result
      });
    } catch (error: any) {
      next(error);
    }
  }
}

export const profileSetupController = new ProfileSetupController();
