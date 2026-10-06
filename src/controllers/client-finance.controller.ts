import { Request, Response, NextFunction } from 'express';
import { clientFinanceService } from '../services/client-finance.service';

export const getClientInvoices = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const clientId = (req as any).user?.id;
    if (!clientId) return res.status(401).json({ success: false, message: 'غير مصرح' });
    const data = await clientFinanceService.getInvoices(clientId);
    return res.status(200).json({ success: true, data });
  } catch (error) { next(error); }
};

export const getClientInvoice = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const clientId = (req as any).user?.id;
    if (!clientId) return res.status(401).json({ success: false, message: 'غير مصرح' });
    const data = await clientFinanceService.getInvoice(clientId, String(req.params.id || ''));
    return res.status(200).json({ success: true, data });
  } catch (error) { next(error); }
};

export const getClientWallet = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const clientId = (req as any).user?.id;
    if (!clientId) {
      return res.status(401).json({ success: false, message: 'غير مصرح' });
    }

    const data = await clientFinanceService.getWallet(clientId);
    return res.status(200).json({ success: true, data });
  } catch (error) {
    next(error);
  }
};
