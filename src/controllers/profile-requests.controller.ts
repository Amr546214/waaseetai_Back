import { Request, Response, NextFunction } from 'express';
import { profileRequestsService } from '../services/profile-requests.service';

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
