import { Request, Response, NextFunction } from 'express';
import { marketerOverviewService } from '../services/marketer-overview.service';

export class MarketerOverviewController {
  
  public async getSummary(req: Request, res: Response, next: NextFunction) {
    try {
      const userId = req.user!.id;
      const summary = await marketerOverviewService.getSummary(userId);
      
      res.status(200).json({
        success: true,
        data: summary,
      });
    } catch (error) {
      next(error);
    }
  }

  public async getChannelPerformance(req: Request, res: Response, next: NextFunction) {
    try {
      const userId = req.user!.id;
      const channels = await marketerOverviewService.getChannelPerformance(userId);
      
      res.status(200).json({
        success: true,
        data: channels,
      });
    } catch (error) {
      next(error);
    }
  }

  public async getCommissions(req: Request, res: Response, next: NextFunction) {
    try {
      const userId = req.user!.id;
      const limit = parseInt(req.query.limit as string) || 5;
      
      const commissions = await marketerOverviewService.getRecentCommissions(userId, limit);
      
      res.status(200).json({
        success: true,
        data: commissions,
      });
    } catch (error) {
      next(error);
    }
  }

  public async getAiInsights(req: Request, res: Response, next: NextFunction) {
    try {
      const userId = req.user!.id;
      const insights = await marketerOverviewService.getAiInsights(userId);
      
      res.status(200).json({
        success: true,
        data: insights,
      });
    } catch (error) {
      next(error);
    }
  }

  public async getReferrals(req: Request, res: Response, next: NextFunction) {
    try {
      const userId = req.user!.id;
      const page = parseInt(req.query.page as string) || 1;
      const limit = parseInt(req.query.limit as string) || 20;

      const data = await marketerOverviewService.getReferredUsers(userId, page, limit);

      res.status(200).json({
        success: true,
        data: data.items,
        pagination: data.pagination,
      });
    } catch (error) {
      next(error);
    }
  }

  public async getRefLinks(req: Request, res: Response, next: NextFunction) {
    try {
      const userId = req.user!.id;
      const data = await marketerOverviewService.getRefLinks(userId);
      
      res.status(200).json({
        success: true,
        data,
      });
    } catch (error) {
      next(error);
    }
  }

  public async createCustomLink(req: Request, res: Response, next: NextFunction) {
    try {
      const userId = req.user!.id;
      const body = req.body;
      const newLink = await marketerOverviewService.createCustomLink(userId, body);
      
      res.status(201).json({
        success: true,
        data: newLink,
      });
    } catch (error) {
      next(error);
    }
  }

  public async updateSettings(req: Request, res: Response, next: NextFunction) {
    try {
      const userId = req.user!.id;
      const body = req.body;
      const updated = await marketerOverviewService.updateSettings(userId, body);
      
      res.status(200).json({
        success: true,
        data: updated,
      });
    } catch (error) {
      next(error);
    }
  }
}

export const marketerOverviewController = new MarketerOverviewController();
