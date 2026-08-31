import { Request, Response, NextFunction } from 'express';
import { exploreRequestsService } from '../services/explore-requests.service';

export class ExploreRequestsController {
  
  // GET /api/provider/explore-requests
  public async getExploreRequests(req: Request, res: Response, next: NextFunction) {
    try {
      const providerId = req.user!.userId;
      
      const filters = {
        category: req.query.category as string,
        tab: req.query.tab as string,
        sortBy: req.query.sortBy as string,
        search: req.query.search as string
      };

      const result = await exploreRequestsService.getExploreRequests(providerId, filters);

      res.status(200).json({
        success: true,
        data: result
      });
    } catch (error) {
      next(error);
    }
  }

  // POST /api/provider/explore-requests/:id/toggle-save
  public async toggleSave(req: Request, res: Response, next: NextFunction) {
    try {
      const providerId = req.user!.userId;
      const projectId = req.params.id as string;
      
      const result = await exploreRequestsService.toggleSave(providerId, projectId);

      res.status(200).json({
        success: true,
        data: result
      });
    } catch (error) {
      next(error);
    }
  }

}

export const exploreRequestsController = new ExploreRequestsController();
