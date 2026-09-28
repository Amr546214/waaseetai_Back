import { Request, Response, NextFunction } from 'express';
import { paypalFinanceService } from '../services/paypal-finance.service';
import { CreatePaypalOrderDto, CapturePaypalOrderDto } from '../dtos/paypal.dto';

export const createPaypalOrder = async (req: Request, res: Response, next: NextFunction) => {
	try {
		const clientId = (req as any).user?.id;
		if (!clientId) return res.status(401).json({ success: false, message: 'غير مصرح' });
		const { amount } = req.body as CreatePaypalOrderDto;
		const data = await paypalFinanceService.initiateDeposit(clientId, amount);
		return res.status(200).json({ success: true, data });
	} catch (error) {
		next(error);
	}
};

export const capturePaypalOrder = async (req: Request, res: Response, next: NextFunction) => {
	try {
		const clientId = (req as any).user?.id;
		if (!clientId) return res.status(401).json({ success: false, message: 'غير مصرح' });
		const { paypalOrderId } = req.body as CapturePaypalOrderDto;
		const data = await paypalFinanceService.captureDeposit(clientId, paypalOrderId);
		return res.status(200).json({ success: true, message: 'تم إيداع الرصيد بنجاح عبر PayPal', data });
	} catch (error) {
		next(error);
	}
};
