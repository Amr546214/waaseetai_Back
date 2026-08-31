import { Request, Response, NextFunction } from 'express';
import { dashboardService } from '../services/dashboard.service';

export class DashboardController {
  /**
   * Handle getting unified dashboard stats
   */
  public async getStats(req: Request, res: Response, next: NextFunction) {
    try {
      // user is guaranteed to be set by the requireAuth/authenticate middleware
      const { id: userId, accountType } = req.user!;

      const stats = await dashboardService.getStats(userId, accountType);

      res.status(200).json({
        success: true,
        message: 'تم استرجاع الإحصائيات بنجاح',
        data: stats
      });
    } catch (error) {
      // Pass errors to the global error handler safely
      next(error);
    }
  }
}

export const dashboardController = new DashboardController();
