import { Request, Response, NextFunction } from 'express';
import { ZodError } from 'zod';
import { adminAccountService } from '../services/admin-account.service';
import { zodFieldErrors } from '../utils/app-error';

// Arabic text for zod's default messages on the admin profile form.
const ACCOUNT_FIELD_MESSAGES = { firstName: 'الاسم الأول مطلوب (حتى 60 حرفًا)', lastName: 'الاسم الأخير مطلوب (حتى 60 حرفًا)', phoneCountryCode: 'رمز الدولة غير صالح (مثال: +966)', phoneNumber: 'رقم الجوال غير صالح (6 إلى 15 رقمًا)' };

const ctx = (req: Request) => ({ sessionId: req.user?.sessionId, ipAddress: req.ip, actorLabel: req.user?.email });
const q = (v: unknown) => (typeof v === 'string' ? v : undefined);

export const getAuditLog = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { page, limit } = req.query;
    const data = await adminAccountService.listAuditLog({ page, limit, q: q(req.query.q), eventType: q(req.query.eventType), severity: q(req.query.severity), source: q(req.query.source), actorId: q(req.query.actorId), from: q(req.query.from), to: q(req.query.to), scope: q(req.query.scope) });
    res.json({ success: true, data });
  } catch (e) { next(e); }
};
export const getAdmins = async (_req: Request, res: Response, next: NextFunction) => {
  try { res.json({ success: true, data: await adminAccountService.listAdmins() }); } catch (e) { next(e); }
};
export const getMe = async (req: Request, res: Response, next: NextFunction) => {
  try { res.json({ success: true, data: await adminAccountService.getMe(req.user!.id) }); } catch (e) { next(e); }
};
export const updateMe = async (req: Request, res: Response, next: NextFunction) => {
  try { res.json({ success: true, data: await adminAccountService.updateMe(req.user!.id, req.body, ctx(req)) }); }
  catch (e: any) {
    if (e instanceof ZodError) return void res.status(400).json({ success: false, message: 'بيانات غير صالحة', errors: zodFieldErrors(e.issues, ACCOUNT_FIELD_MESSAGES) });
    if (e?.message === 'NO_FIELDS') return void res.status(400).json({ success: false, message: 'لا توجد حقول للتحديث' });
    if (e?.message === 'PHONE_TAKEN') return void res.status(409).json({ success: false, message: 'رقم الجوال مستخدم في حساب آخر' });
    next(e);
  }
};
export const getSessions = async (req: Request, res: Response, next: NextFunction) => {
  try { res.json({ success: true, data: await adminAccountService.listSessions(req.user!.id, req.user?.sessionId) }); } catch (e) { next(e); }
};
export const deleteSession = async (req: Request, res: Response, next: NextFunction) => {
  try { res.json({ success: true, data: await adminAccountService.terminateSession(req.user!.id, String(req.params.id), req.user?.sessionId) }); }
  catch (e: any) {
    if (e?.message === 'SESSION_NOT_FOUND') return void res.status(404).json({ success: false, message: 'الجلسة غير موجودة' });
    if (e?.message === 'CANNOT_REVOKE_CURRENT_SESSION') return void res.status(400).json({ success: false, message: 'لا يمكن إنهاء الجلسة الحالية من هنا؛ استخدم تسجيل الخروج' });
    next(e);
  }
};
export const deleteOtherSessions = async (req: Request, res: Response, next: NextFunction) => {
  try { res.json({ success: true, data: await adminAccountService.terminateOtherSessions(req.user!.id, req.user?.sessionId) }); } catch (e) { next(e); }
};
