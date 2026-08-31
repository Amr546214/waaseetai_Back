import { Request, Response } from 'express';
import { accountAuditLogService } from '../services/account-logs.service';

class AccountLogsController {
  async getUserLogs(req: Request, res: Response) {
    try {
      const userId = req.user?.id;
      if (!userId) return res.status(401).json({ success: false, message: 'Unauthorized' });
      const data = await accountAuditLogService.getUserLogs(userId, req.query as any);
      res.json({ success: true, data });
    } catch (error: any) {
      res.status(500).json({ success: false, message: error.message });
    }
  }

  async getUserLog(req: Request, res: Response) {
    try {
      const userId = req.user?.id;
      if (!userId) return res.status(401).json({ success: false, message: 'Unauthorized' });
      const data = await accountAuditLogService.getUserLog(userId, req.params.id as string);
      res.json({ success: true, data });
    } catch (error: any) {
      res.status(error.message === 'AUDIT_LOG_NOT_FOUND' ? 404 : 500).json({ success: false, message: error.message });
    }
  }
}

export const accountLogsController = new AccountLogsController();
