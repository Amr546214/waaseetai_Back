import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { authenticate, requireActiveUser } from '../middlewares/auth.middleware';
import { paymentLimiter } from '../middlewares/rate-limit.middleware';
import { paymentMethodsService as service } from '../services/payment-methods.service';
import { paymentRole } from '../utils/payment-methods';
import { AppError } from '../utils/app-error';

const router = Router();
router.use(authenticate, requireActiveUser);
const actor = (req: Request) => {
  const u = req.user!;
  const fallback = u.accountType.startsWith('PROVIDER_') ? 'PROVIDER' : u.accountType.startsWith('CLIENT_') ? 'CLIENT' : u.accountType === 'MARKETING_BROKER' ? 'AFFILIATE' : null;
  if (!u.sessionId) throw new AppError('سجّل الدخول مجددًا لإدارة طرق الدفع', 401);
  const role = paymentRole(u.activeRole ?? fallback);
  if (req.query.role !== role) throw new AppError('تغيّر الدور النشط، افتح طرق الدفع من لوحة الحساب الحالية', 403, undefined, 'PAYMENT_ROLE_CHANGED');
  return { userId: u.userId, sessionId: u.sessionId, role };
};
const respond = (action: (req: Request) => Promise<unknown>) => async (req: Request, res: Response, next: NextFunction) => {
  try { res.set('Cache-Control', 'no-store'); res.json({ success: true, data: await action(req) }); }
  catch (error) {
    if (error instanceof z.ZodError) return next(new AppError('بيانات غير صحيحة، يرجى مراجعة الحقول المحددة', 400, error.issues.map(i => ({ field: i.path.join('.'), path: i.path.join('.'), message: 'قيمة غير صحيحة' }))));
    next(error);
  }
};
const id = (req: Request) => z.string().uuid().parse(req.params.id);
router.get('/', respond(req => service.list(actor(req))));
router.post('/alrajhi', paymentLimiter, respond(req => service.bank(actor(req), req.body)));
router.post('/paypal/start', paymentLimiter, respond(req => service.start(actor(req))));
router.post('/paypal/complete', paymentLimiter, respond(req => {
  const data = z.object({ code: z.string().min(1).max(4096), state: z.string().regex(/^[A-Za-z0-9_-]{43}$/) }).strict().parse(req.body);
  return service.complete(actor(req), data.code, data.state);
}));
router.post('/:id/activate', paymentLimiter, respond(req => service.activate(actor(req), id(req), req.ip)));
router.post('/:id/confirm', paymentLimiter, respond(req => {
  const data = z.object({ code: z.string().regex(/^\d{6}$/) }).strict().parse(req.body);
  return service.confirm(actor(req), id(req), data.code);
}));
router.get('/:id', respond(req => service.detail(actor(req), id(req))));
router.post('/:id/default', paymentLimiter, respond(req => service.makeDefault(actor(req), id(req))));
router.delete('/:id', paymentLimiter, respond(req => service.remove(actor(req), id(req))));
export default router;
