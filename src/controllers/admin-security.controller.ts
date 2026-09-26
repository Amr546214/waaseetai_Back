import { Request, Response, NextFunction } from 'express';
import { adminSecurityService } from '../services/admin-security.service';

export const getSecurityEvents = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const limit = req.query.limit ? Number(req.query.limit) : undefined;
    const result = await adminSecurityService.getSecurityEvents(limit);
    res.status(200).json({ success: true, data: result });
  } catch (error) {
    next(error);
  }
};

export const getFlaggedAccounts = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const limit = req.query.limit ? Number(req.query.limit) : undefined;
    const result = await adminSecurityService.getFlaggedAccounts(limit);
    res.status(200).json({ success: true, data: result });
  } catch (error) {
    next(error);
  }
};
