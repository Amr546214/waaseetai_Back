import { Router, Request, Response, NextFunction } from 'express';
import { AccountType, WithdrawalStatus } from '@prisma/client';
import { authenticate, authorize, requireActiveUser } from '../middlewares/auth.middleware';
import { adminFinanceService } from '../services/admin-finance.service';
import { adminAudit } from '../services/admin-audit.service';
import { AppError } from '../utils/app-error';
import { requirePermission } from '../middlewares/admin-access.middleware';

const router = Router();
router.use(authenticate, requireActiveUser, requirePermission('finance.read'));

const wrap = (fn: (req: Request) => Promise<unknown>) => async (req: Request, res: Response, next: NextFunction) => {
	try { res.json({ success: true, data: await fn(req) }); } catch (error) { next(error); }
};
const str = (v: unknown) => (v ? String(v) : undefined);
const invoiceStatus = (req: Request): 'paid' | 'due' | undefined => {
	const v = str(req.query.status);
	if (v && v !== 'paid' && v !== 'due') throw new AppError('حالة الفاتورة غير صحيحة', 400);
	return v as 'paid' | 'due' | undefined;
};
const csv = (name: string, build: (req: Request) => Promise<string>) => async (req: Request, res: Response, next: NextFunction) => {
	try {
		const body = await build(req);
		await adminAudit.record({ adminId: req.user!.id, entity: 'FINANCE', entityId: name, eventType: 'FINANCE_EXPORT', title: 'تصدير بيانات مالية', summary: `تصدير ملف ${name}.csv`, severity: 'WARNING' });
		res.setHeader('Content-Type', 'text/csv; charset=utf-8');
		res.setHeader('Content-Disposition', `attachment; filename="${name}-${new Date().toISOString().slice(0, 10)}.csv"`);
		res.send(body);
	} catch (error) { next(error); }
};

router.get('/overview', wrap(req => adminFinanceService.overview(Number(req.query.months) || 6)));
router.get('/transactions', wrap(req => adminFinanceService.transactions({ type: str(req.query.type)?.toUpperCase(), status: str(req.query.status)?.toUpperCase(), q: str(req.query.q) }, Number(req.query.page) || 1, Number(req.query.limit) || 20)));
router.get('/transactions.csv', csv('transactions', req => adminFinanceService.transactionsCsv({ type: str(req.query.type)?.toUpperCase(), status: str(req.query.status)?.toUpperCase(), q: str(req.query.q) })));
router.get('/commissions', wrap(req => adminFinanceService.commissions(Number(req.query.page) || 1, Number(req.query.limit) || 20)));
router.get('/commissions.csv', csv('commissions', () => adminFinanceService.commissionsCsv()));
router.get('/invoices', wrap(req => adminFinanceService.invoices(invoiceStatus(req), Number(req.query.page) || 1, Number(req.query.limit) || 20)));
router.get('/invoices.csv', csv('invoices', req => adminFinanceService.invoicesCsv(invoiceStatus(req))));
router.get('/withdrawals.csv', csv('withdrawals', req => {
	const raw = str(req.query.status)?.toUpperCase();
	if (raw && !Object.values(WithdrawalStatus).includes(raw as WithdrawalStatus)) throw new AppError('حالة طلب السحب غير صحيحة', 400);
	return adminFinanceService.withdrawalsCsv(raw as WithdrawalStatus | undefined);
}));

export default router;
