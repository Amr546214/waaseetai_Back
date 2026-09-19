import { Request, Response, NextFunction } from 'express';
import { profileRequestsService } from '../services/profile-requests.service';
import { CreateIdentityRequestDto } from '../dtos/profile-requests.dto';

export class ProfileRequestsController {
  public async getRequests(req: Request, res: Response, next: NextFunction) {
    try {
      const userId = req.user!.id;
      const data = await profileRequestsService.getRequests(userId);

      res.status(200).json({
        success: true,
        data,
      });
    } catch (error) {
      next(error);
    }
  }

  public async createRequests(req: Request, res: Response, next: NextFunction) {
    try {
      const userId = req.user!.id;
      const body = req.body as CreateIdentityRequestDto;
      const data = await profileRequestsService.createIdentityRequests(userId, body);

      res.status(201).json({
        success: true,
        data,
        message: 'تم إرسال طلب التعديل للمراجعة بنجاح'
      });
    } catch (error) {
      next(error);
    }
  }

  public async withdrawRequest(req: Request, res: Response, next: NextFunction) {
    try {
      const userId = req.user!.id;
      const id = req.params.id as string;
      
      const data = await profileRequestsService.withdrawRequest(userId, id);
      
      res.status(200).json({
        success: true,
        data,
        message: 'Request withdrawn successfully'
      });
    } catch (error) {
      next(error);
    }
  }
}

export const profileRequestsController = new ProfileRequestsController();
