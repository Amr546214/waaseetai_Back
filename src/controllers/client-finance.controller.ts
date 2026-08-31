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

export const initiateDeposit = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const clientId = (req as any).user?.id;
    if (!clientId) {
      return res.status(401).json({ success: false, message: 'غير مصرح' });
    }

    const { amount, paymentMethod } = req.body;
    const session = await clientFinanceService.initiateDeposit(clientId, Number(amount), paymentMethod);
    return res.status(200).json({ success: true, data: session });
  } catch (error: any) {
    return res.status(400).json({ success: false, message: error.message || 'تعذر بدء عملية الإيداع' });
  }
};

export const verifyDeposit = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const clientId = (req as any).user?.id;
    if (!clientId) {
      return res.status(401).json({ success: false, message: 'غير مصرح' });
    }

    const { paymentId, amount, paymentMethod, description } = req.body;
    const result = await clientFinanceService.verifyAndProcessDeposit(clientId, {
      paymentId,
      amount: amount === undefined ? undefined : Number(amount),
      paymentMethod,
      description
    });

    return res.status(200).json({
      success: true,
      message: 'تم إيداع الرصيد بنجاح',
      data: result
    });
  } catch (error: any) {
    return res.status(400).json({ success: false, message: error.message || 'فشل التحقق من الإيداع' });
  }
};
