import { Request, Response, NextFunction } from 'express';
import { dashboardService } from '../services/dashboard.service';
import { financeReportAiService } from '../services/finance-report-ai.service';

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

  public async analyzeFinanceReport(req: Request, res: Response, next: NextFunction) {
    try {
      const { id: userId, accountType } = req.user!;

      const data = await financeReportAiService.analyzeFinancialReport(
        userId,
        accountType
      );

      res.status(200).json({
        success: true,
        message: 'AI financial report insights completed successfully.',
        data
      });
    } catch (error) {
      next(error);
    }
  }
}

export const dashboardController = new DashboardController();
