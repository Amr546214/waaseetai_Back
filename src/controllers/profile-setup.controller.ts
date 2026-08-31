import { Request, Response, NextFunction } from 'express';
import { profileSetupSchema } from '../dtos/profile-setup.dto';
import { profileSetupService } from '../services/profile-setup.service';

export class ProfileSetupController {
  public async setupProfile(req: Request, res: Response, next: NextFunction) {
    try {
      // 1. Validate incoming data
      const validatedData = profileSetupSchema.parse(req.body);

      // 2. Extract user info from authenticated request
      const userId = req.user!.userId;
      const accountType = req.user!.accountType;

      // 3. Execute setup transaction
      const result = await profileSetupService.saveProfileSetup(userId, accountType, validatedData);

      // 4. Return robust response
      res.status(200).json({
        success: true,
        message: 'تم حفظ بيانات إعداد الملف الشخصي بنجاح وإرسال الوثائق للمراجعة',
        data: result
      });
    } catch (error: any) {
      next(error);
    }
  }
}

export const profileSetupController = new ProfileSetupController();
