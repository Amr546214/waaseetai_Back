import { Request, Response, NextFunction } from 'express';
import { marketerProfileService } from '../services/marketer-profile.service';

export class MarketerProfileController {
  
  public async getProfile(req: Request, res: Response, next: NextFunction) {
    try {
      const userId = req.user!.id;
      const profile = await marketerProfileService.getProfile(userId);
      
      res.status(200).json({
        success: true,
        data: profile,
      });
    } catch (error) {
      next(error);
    }
  }

  public async updateMarketingInfo(req: Request, res: Response, next: NextFunction) {
    try {
      const userId = req.user!.id;
      const body = req.body;
      const updated = await marketerProfileService.updateMarketingInfo(userId, body);
      
      res.status(200).json({
        success: true,
        data: updated,
      });
    } catch (error) {
      next(error);
    }
  }

  public async addChannel(req: Request, res: Response, next: NextFunction) {
    try {
      const userId = req.user!.id;
      const body = req.body;
      const newChannel = await marketerProfileService.addChannel(userId, body);
      
      res.status(201).json({
        success: true,
        data: newChannel,
      });
    } catch (error) {
      next(error);
    }
  }

  public async removeChannel(req: Request, res: Response, next: NextFunction) {
    try {
      const userId = req.user!.id;
      const id = req.params.id as string;
      
      await marketerProfileService.removeChannel(userId, id);
      
      res.status(200).json({
        success: true,
        message: 'Channel removed successfully'
      });
    } catch (error) {
      next(error);
    }
  }

  public async updateBankInfo(req: Request, res: Response, next: NextFunction) {
    try {
      const userId = req.user!.id;
      const body = req.body;
      
      const updated = await marketerProfileService.updateBankInfo(userId, body);
      
      res.status(200).json({
        success: true,
        data: updated,
      });
    } catch (error) {
      next(error);
    }
  }
}

export const marketerProfileController = new MarketerProfileController();
